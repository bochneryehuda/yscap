/**
 * Borrower-facing API (all endpoints require a borrower token; everything is
 * scoped to req.actor.id so a borrower can only ever see their own data).
 *   Profile · Applications (many, per-address) · LLCs+docs · Track records
 *   · Checklists (borrower-visible) · Documents · Notifications · Messages
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const { scrubText, scrubFields } = require('../lib/borrower-safe');
const cfg = require('../config');
const C = require('../lib/crypto');
const storage = require('../lib/storage');
const { requireAuth, requireBorrower } = require('../auth');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { fileReplyTo } = require('../lib/file-address');   // #68 per-file shared reply-to
const { enqueueSitewirePush } = require('../sitewire/enqueue'); // birth push on the Request-a-draw click (self-gated)
const { redactPII } = require('../lib/redact');
const { serveDocument } = require('../lib/serve-document');
const { decodeUploadBase64, safeFilename } = require('../lib/upload-bytes');
const pricing = require('../lib/pricing');
const manualProgram = require('../lib/manual-program');
const termOpts = require('../lib/term-options');
const workflowAuto = require('../lib/workflow-automation');
const { persistProductRegistration } = require('../lib/product-registration');
const { syncExperienceChecklistForApplication, syncExperienceChecklistForBorrower, RECENT_EXIT_SQL } = require('../lib/experience');
const llcLib = require('../lib/llc');
const apprCard = require('../lib/appraisal-card');
const apprScore = require('../lib/appraisal/scoring');
const conditionEngine = require('../lib/conditions/engine');
const conditionRegistry = require('../lib/conditions/field-registry');
const changeRequests = require('../lib/change-requests');
const { enqueueChecklistStatusPush } = require('../clickup/enqueue');

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
// THE one definition of "my files" for the borrower portal (owner-directed
// 2026-07-15 night, Reuven Steimetz): a file is mine when I am its borrower,
// its co-borrower, or when its borrower/co-borrower is a profile LINKED to
// mine (borrower_profile_links, written by the staff "Allow — same email for
// both" review action for spouses / same-person duplicate profiles sharing an
// email). A login on either profile then sees BOTH people's files. Links are
// staff-granted only, symmetric (both directions stored), and audited.
// Profile-scoped data (LLC library, track record, profile edits) deliberately
// stays per-profile — only FILE access flows through this predicate.
const OWN_FILE_SQL = (alias, p) => {
  const a = alias ? alias + '.' : '';
  return `(${a}borrower_id=${p} OR ${a}co_borrower_id=${p}` +
    ` OR ${a}borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p})` +
    ` OR ${a}co_borrower_id IN (SELECT linked_borrower_id FROM borrower_profile_links WHERE borrower_id=${p}))`;
};
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
async function audit(req, action, entity_type, entity_id, detail) {
  // detail lands in a jsonb column: an object serializes to valid JSON via pg, but a
  // bare scalar is rejected ("invalid input syntax for type json"). Wrap any scalar
  // so a logging write can never fail an otherwise-successful request.
  let d = detail;
  if (d != null && typeof d !== 'object') d = { note: String(d) };
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('borrower',$1,$2,$3,$4,$5,$6,$7)`,
      [me(req), action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, d || null]);
  } catch (e) {   // best-effort — a log write must never fail a completed action
    console.warn(`[audit] failed to log ${action}: ${db.describeError ? db.describeError(e) : e.message}`);
  }
}
function intField(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}
function moneyField(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
}
function stripToolAttachments(payload) {
  const raw = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  const attachments = raw.slice(0, 4)
    .map((a) => ({
      filename: safeFilename(a.filename || 'tool-export.txt'),
      contentType: String(a.contentType || 'application/octet-stream').slice(0, 120),
      dataBase64: String(a.dataBase64 || ''),
    }))
    .filter((a) => a.filename && a.dataBase64);
  const clean = { ...(payload || {}) };
  delete clean.attachments;
  if (attachments.length) {
    clean.export_files = attachments.map((a) => ({ filename: a.filename, contentType: a.contentType }));
  }
  return { payload: clean, attachments };
}
async function storeToolAttachments({ req, appId, borrowerId, itemId, toolKey, attachments }) {
  if (!attachments || !attachments.length) return [];
  // Validate/decode FIRST (strict decode — a data:-URL prefix or non-base64
  // junk must never garble stored bytes), and only supersede the previous
  // exports when at least one valid replacement exists: a submission whose
  // attachments all fail must not strip the condition of its current documents.
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  const valid = [];
  for (const a of attachments) {
    let buf;
    try { ({ buf } = decodeUploadBase64(a.dataBase64)); } catch (_) { continue; }
    if (!buf.length || buf.length > maxBytes) continue;
    valid.push({ a, buf });
  }
  if (!valid.length) return [];
  await db.query(
    `UPDATE documents
        SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE checklist_item_id=$1
        AND borrower_id=$2
        AND source_type='system'
        AND is_current=true`,
    [itemId, borrowerId]);

  const out = [];
  for (const { a, buf } of valid) {
    const { ref, provider } = await storage.save(buf, { filename: a.filename });
    const r = await db.query(
      `INSERT INTO documents
         (checklist_item_id,application_id,borrower_id,filename,content_type,size_bytes,
          storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,source_type,visibility,doc_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'borrower',$3,'system','borrower',$9) RETURNING id`,
      [itemId, appId, borrowerId, a.filename, a.contentType, buf.length, provider, ref, toolKey + '_export']);
    out.push({ id: r.rows[0].id, filename: a.filename });
  }
  if (out.length) await audit(req, 'store_tool_exports', 'checklist_item', itemId, { toolKey, files: out.map((x) => x.filename) });
  if (out.length) { try { require('../lib/sharepoint-backup').kick(); } catch (_) {} }
  return out;
}

// ---------------- PROFILE (canonical PII, shared across applications) ----------------
router.get('/profile', async (req, res) => {
  const r = await db.query(
    `SELECT b.id,b.first_name,b.last_name,b.email,b.cell_phone,b.date_of_birth,b.ssn_last4,b.fico,
            b.current_address,b.mailing_address,b.years_at_residence,b.months_at_residence,b.residence_since,
            b.housing_status,b.housing_payment,b.citizenship,b.marital_status,
            b.photo_id_document_id,b.contact_type,b.tier,
            o.full_name AS owning_officer_name, o.email AS owning_officer_email
     FROM borrowers b
     LEFT JOIN staff_users o ON o.id=b.primary_officer_id AND o.is_active=true
     WHERE b.id=$1`, [me(req)]);
  // Live residence duration from the anchored move-in date (owner-directed
  // 2026-07-14) — the stored years/months are recomputed to "now" so a profile
  // opened months after the count was entered shows the real elapsed time.
  const out = require('../lib/residence').withLiveResidence(r.rows[0]) || {};
  // `locked` = this borrower has at least one ACCEPTED (registered) file, so their
  // identity edits (name/DOB/SSN/phone/credit/citizenship) now go through loan-team
  // approval rather than saving directly (owner-directed 2026-07-20). The profile
  // screen uses this to switch off silent autosave for those fields and explain why.
  try {
    const lk = await db.query(
      `SELECT 1 FROM applications a JOIN product_registrations pr ON pr.application_id=a.id AND pr.is_current
        WHERE (${OWN_FILE_SQL("a", "$1")}) AND a.deleted_at IS NULL LIMIT 1`, [me(req)]);
    out.locked = !!lk.rows[0];
  } catch (_) { out.locked = false; }
  res.json(out);
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
  if (b.fico !== undefined) fields.fico = require('../lib/fields').sanitizeFico(b.fico);  // #90: 3-digit, 300–850
  if (b.citizenship !== undefined) fields.citizenship = clean(b.citizenship);
  if (b.maritalStatus !== undefined) fields.marital_status = clean(b.maritalStatus);
  if (b.yearsAtResidence !== undefined) fields.years_at_residence = (b.yearsAtResidence === '' || b.yearsAtResidence == null) ? null : Number(b.yearsAtResidence);
  if (b.monthsAtResidence !== undefined) fields.months_at_residence = (b.monthsAtResidence === '' || b.monthsAtResidence == null) ? null : parseInt(b.monthsAtResidence, 10);
  // Anchor the move-in DATE whenever a fresh count is entered (owner-directed
  // 2026-07-14): the count is a snapshot as of NOW; storing residence_since lets
  // every later read compute the live duration without the borrower re-typing.
  if (b.yearsAtResidence !== undefined || b.monthsAtResidence !== undefined) {
    const y = fields.years_at_residence != null ? fields.years_at_residence : null;
    const m = fields.months_at_residence != null ? fields.months_at_residence : null;
    fields.residence_since = (y || m) ? require('../lib/residence').moveInFrom(y, m) : null;
  }
  if (b.housingStatus !== undefined) fields.housing_status = clean(b.housingStatus);
  if (b.housingPayment !== undefined) fields.housing_payment = (b.housingPayment === '' || b.housingPayment == null) ? null : Number(String(b.housingPayment).replace(/[^0-9.]/g, '')) || null;
  if (b.currentAddress !== undefined) fields.current_address = b.currentAddress ? JSON.stringify(b.currentAddress) : null;
  if (b.mailingDifferent === false) fields.mailing_address = null;
  else if (b.mailingAddress !== undefined) fields.mailing_address = b.mailingAddress ? JSON.stringify(b.mailingAddress) : null;

  // 2026-07-15 incident: DOB must be a real calendar date in a sane year — a
  // mid-typing artifact (year 0026), an impossible day (2026-02-31), or a
  // malformed string never persists (pre-merge audit #2: the round-trip check
  // catches impossible days the regex alone lets through).
  if (fields.date_of_birth != null) {
    // Real calendar date, sane year — and a typed 2-DIGIT year resolves to the
    // real one (26 → the century that makes an adult), so the portal and
    // ClickUp always read the same date. Truly invalid input still 400s.
    const dob = require('../lib/fields').sanitizeDob(fields.date_of_birth);
    if (dob == null) {
      return res.status(400).json({ error: 'date of birth must be a valid YYYY-MM-DD' });
    }
    fields.date_of_birth = dob;
  }
  // Owner-directed 2026-07-20: once ANY of this borrower's files is ACCEPTED (a
  // product is registered), the borrower can no longer change their identity on
  // their side directly — name / DOB / SSN / phone / credit / citizenship each
  // become a pending change request the loan team approves, showing before → after.
  // Non-identity profile details (address, housing, residence, marital) stay
  // directly editable. The request is anchored to the borrower's most-recently
  // accepted file, whose team approves; approval writes the shared borrower row.
  const changeRequested = [];
  let ssnGated = false;
  const anchor = (await db.query(
    `SELECT a.id FROM applications a
       JOIN product_registrations pr ON pr.application_id=a.id AND pr.is_current
      WHERE (${OWN_FILE_SQL("a", "$1")}) AND a.deleted_at IS NULL
      ORDER BY pr.created_at DESC LIMIT 1`, [me(req)])).rows[0];
  if (anchor) {
    for (const col of Object.keys(fields)) {
      if (!changeRequests.isBorrowerField(col)) continue;   // identity fields only; keep address/housing/etc. live
      try {
        const cr = await changeRequests.openRequest(anchor.id, col, fields[col],
          { reason: b.reason || null, requesterKind: 'borrower', requesterId: me(req), targetBorrowerId: me(req) });
        if (!cr.unchanged) changeRequested.push(cr);
      } catch (_) { /* skip an invalid field, keep the rest */ }
      delete fields[col];   // never a live write on a locked borrower
    }
    if (b.ssn) {
      try {
        const cr = await changeRequests.openRequest(anchor.id, 'ssn', b.ssn,
          { reason: b.reason || null, requesterKind: 'borrower', requesterId: me(req), targetBorrowerId: me(req) });
        if (!cr.unchanged) changeRequested.push(cr);
      } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      ssnGated = true;
    }
  }
  const sets = [], vals = []; let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=$${i++}`); vals.push(v); }
  if (b.ssn && !ssnGated) {
    // #91/#92: validate server-side (the "Add SSN" button gates to 9 digits, but a
    // direct/old-client caller must not persist a partial or non-numeric SSN).
    const s = C.ssnForStorage(b.ssn);
    if (!s) return res.status(400).json({ error: 'Enter a valid 9-digit SSN.' });
    sets.push(`ssn_encrypted=$${i++}`); vals.push(s.encrypted);
    sets.push(`ssn_last4=$${i++}`); vals.push(s.last4);
  }
  // Nothing to do only when there is neither a live edit nor a proposed change.
  if (!sets.length && !changeRequested.length) return res.status(400).json({ error: 'nothing to update' });
  // The live write covers only the fields that stayed direct (a locked borrower's
  // identity fields were split out into change requests above).
  if (sets.length) {
    // Before-image of the identity-critical fields for the audit trail (incident
    // gap: update_profile logged no values, so changes couldn't be reconstructed).
    const CRITICAL = ['cell_phone', 'date_of_birth', 'fico', 'citizenship'];
    const changedCritical = CRITICAL.filter((k) => k in fields);
    let beforeImg;
    if (changedCritical.length) {
      try { beforeImg = (await db.query(`SELECT ${changedCritical.join(', ')} FROM borrowers WHERE id=$1`, [me(req)])).rows[0]; } catch (_) {}
    }
    sets.push('updated_at=now()'); vals.push(me(req));
    await db.query(`UPDATE borrowers SET ${sets.join(',')} WHERE id=$${i}`, vals);
    await audit(req, 'update_profile', 'borrower', me(req), {
      changed: Object.keys(fields), ssn: !!(b.ssn && !ssnGated),
      before: beforeImg || undefined,
      after: changedCritical.length ? Object.fromEntries(changedCritical.map((k) => [k, fields[k]])) : undefined });
  }
  // Team notice for the proposed identity changes (before → after), on the anchor file.
  if (changeRequested.length && anchor) {
    try { await notifyTeamOfChangeRequests(anchor.id, changeRequested); } catch (_) {}
  }
  // Mapped borrower fields propagate to ClickUp immediately on every file this
  // borrower has that is ALREADY linked to a task (a profile edit must never
  // materialize a brand-new ClickUp task as a side effect — hence the filter).
  {
    // current_address included (owner-directed 2026-07-15): the borrower's own
    // home-address correction must reach ClickUp as a SCOPED push — the PII
    // overwrite shield deliberately stops full repushes from rewriting it, so
    // this scoped path is the ONLY way a differing address updates ClickUp.
    const MAPPED = ['date_of_birth', 'cell_phone', 'fico', 'citizenship', 'years_at_residence', 'housing_status', 'housing_payment', 'current_address'];
    const pushKeys = MAPPED.filter((k) => k in fields);
    if (pushKeys.length) {
      try {
        const apps = await db.query(
          `SELECT id FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`, [me(req)]);
        const { enqueueClickupPush } = require('../clickup/enqueue');
        for (const row of apps.rows) enqueueClickupPush(row.id, pushKeys).catch(() => {});
      } catch (_) { /* propagation is best-effort */ }
    }
  }
  // Profile fields (credit score, citizenship, home state…) feed the condition
  // rule engine — re-check every open file this borrower is on. Only for fields
  // that were actually WRITTEN live; a gated (change-requested) field hasn't moved.
  if (('fico' in fields) || ('citizenship' in fields) || ('current_address' in fields)) {
    try { await conditionEngine.evaluateBorrowerApplications(me(req), { reason: 'profile_updated' }); } catch (_) {}
  }
  res.json({
    ok: true,
    // When the borrower is locked (has an accepted file), tell the UI which identity
    // edits became pending change requests so it can show "sent to your loan team".
    locked: !!anchor,
    changeRequested: changeRequested.map((r) => ({ field: r.field, label: r.field_label, newValue: r.new_value })),
  });
});

// Government photo ID lives on the PROFILE, collected once and reused on every
// file (so a borrower is never asked for it again). Stores the bytes like any
// document and points borrowers.photo_id_document_id at it. Any file's gov-ID
// checklist item is auto-satisfied from this (see generateChecklist).
// Passing applicationId links the ID to that file's gov-ID condition too, so an
// upload made FROM a file's conditions list lands on the profile AND the file.
router.post('/profile/photo-id', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
  try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  let appId = null, appItemId = null;
  if (b.applicationId) {
    const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [b.applicationId, me(req)]);
    if (!own.rows[0]) return res.status(404).json({ error: 'application not found' });
    appId = b.applicationId;
    const it = await db.query(
      `SELECT id FROM checklist_items
        WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id') LIMIT 1`, [appId]);
    appItemId = it.rows[0] ? it.rows[0].id : null;
  }
  try {
    const dupPhoto = await require('../lib/doc-dedup').recentDuplicateDocId({   // idempotency (#87)
      filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'borrower', uploadedById: me(req),
      applicationId: appId, checklistItemId: appItemId, docKind: 'photo_id' });
    if (dupPhoto) return res.status(201).json({ ok: true, documentId: dupPhoto, deduped: true });
    const { ref, provider } = await storage.save(buf, { filename: b.filename });
    const d = await db.query(
      `INSERT INTO documents (borrower_id,application_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
       VALUES ($1,$7,$8,$2,$3,$4,$5,$6,'borrower',$1,'photo_id') RETURNING id`,
      [me(req), b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, appId, appItemId]);
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2, updated_at=now() WHERE id=$1`, [me(req), d.rows[0].id]);
    // Move any government-ID checklist item on the borrower's files to 'received'.
    // A NEW (unreviewed) ID is fresh evidence, so even an already SIGNED-OFF gov-ID
    // condition drops its sign-off and returns for re-review — the prior sign-off
    // attested to the OLD ID (same "new evidence re-opens the condition" rule as a
    // document new-version upload). A true duplicate short-circuits above (dedup),
    // so this only runs for a genuinely different ID.
    await db.query(
      `UPDATE checklist_items SET status='received',
              signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
        WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id')
          AND application_id IN (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$1")})`,
      [me(req)]);
    await audit(req, 'upload_photo_id', 'borrower', me(req));
    try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
    res.status(201).json({ ok: true, documentId: d.rows[0].id });
  } catch (e) { console.warn('[borrower] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---------------- APPLICATIONS (one borrower : many; each a distinct address) ----------------
router.get('/applications', async (req, res) => {
  const r = await db.query(
    `SELECT a.id,a.ys_loan_number,a.program,a.loan_type,a.status,a.property_address,a.loan_amount,
            a.loan_officer_name,a.submitted_at,a.created_at,a.llc_id,a.draw_setup_requested_at,
            (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both')) AS borrower_total,
            (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both') AND ci.status IN ('received','satisfied')) AS borrower_done
     FROM applications a WHERE (${OWN_FILE_SQL("a", "$1")}) AND a.deleted_at IS NULL ORDER BY a.created_at DESC`, [me(req)]);
  res.json(r.rows);
});

// The borrower's cross-file "Action needed" list — everything they must DO right
// now, aggregated in TWO queries (NOT a checklist-call-per-file), so the home screen
// shows it INSTANTLY on login without opening any file (owner-directed 2026-07-20:
// "he needs to see outstanding stuff for him right away … a few documents … without
// going into the file"). Quiet files (funded/closed/on-hold/terminal/intake) never
// nag here — their items wait inside the file. Borrower-SAFE: only borrower_* wording,
// scrubbed of any capital-partner name.
const ACTION_QUIET_STATUSES = ['funded', 'closed', 'on_hold', 'declined', 'withdrawn', 'cancelled', 'file_intake'];
const ACTION_PKG_LABEL = { term_sheet_package: 'term sheet, application & disclosure', heter_iska: 'Heter Iska' };
function propLabelOf(j) {
  if (!j) return '';
  if (typeof j === 'string') return j.trim();
  return j.oneLine || [j.line1 || j.street, j.city, j.state].filter(Boolean).join(', ') || '';
}
router.get('/action-items', async (req, res) => {
  try {
    const uid = me(req);
    // 1) Documents / conditions still waiting on the BORROWER. checklist_items.status
    //    is ('outstanding','requested','received','satisfied','issue') — the borrower
    //    must act on outstanding/requested (to provide) + issue (needs a fix); received
    //    (uploaded, in review) and satisfied (done) are NOT their action, so excluded.
    const docs = (await db.query(
      `SELECT ci.id, ci.application_id AS "applicationId", ci.status,
              COALESCE(ci.borrower_label,'An item your loan team needs') AS label,
              ci.borrower_hint AS hint, ci.is_required AS "required", ci.due_date AS "dueDate",
              COALESCE(ci.issue_reason,
                (SELECT d.rejection_reason FROM documents d
                  WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
                  ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1)) AS "rejectionReason",
              a.ys_loan_number AS "loanNumber", a.property_address AS "propertyAddress"
         FROM checklist_items ci
         JOIN applications a ON a.id = ci.application_id
        WHERE a.deleted_at IS NULL AND (${OWN_FILE_SQL("a", "$1")})
          AND a.status <> ALL($2::text[])
          AND ci.audience IN ('borrower','both')
          AND ci.status IN ('outstanding','requested','issue')
        ORDER BY (ci.status='issue') DESC, ci.due_date ASC NULLS LAST, ci.sort_order, ci.created_at`,
      [uid, ACTION_QUIET_STATUSES])).rows;

    // 2) Packages waiting for THIS borrower's signature (open envelope, they haven't
    //    signed/declined yet). One row per envelope.
    const signs = (await db.query(
      `SELECT DISTINCT ON (e.id) e.id AS "envelopeRowId", e.application_id AS "applicationId", e.purpose,
              a.ys_loan_number AS "loanNumber", a.property_address AS "propertyAddress"
         FROM esign_envelopes e
         JOIN applications a ON a.id = e.application_id
         JOIN esign_recipients r ON r.envelope_row_id = e.id
        WHERE a.deleted_at IS NULL AND (${OWN_FILE_SQL("a", "$1")})
          AND a.status <> ALL($2::text[])
          AND e.status IN ('sent','delivered') AND e.purpose IS NOT NULL
          AND r.borrower_id = $1 AND r.signed_at IS NULL AND r.declined_at IS NULL
        ORDER BY e.id, e.created_at DESC`,
      [uid, ACTION_QUIET_STATUSES])).rows;

    const items = [];
    // Signatures first (most time-sensitive), then fixes, then documents to provide.
    for (const s of signs) {
      items.push({
        kind: 'sign', id: `sign:${s.envelopeRowId}`, applicationId: s.applicationId,
        loanNumber: s.loanNumber || null, property: propLabelOf(s.propertyAddress),
        label: `Sign your ${ACTION_PKG_LABEL[s.purpose] || 'documents'}`,
        hint: 'A quick, secure signature is needed to move your loan forward.',
        priority: 0, route: `/app/${s.applicationId}?esign=1`,
      });
    }
    for (const d of docs) {
      const isIssue = d.status === 'issue';
      items.push({
        kind: isIssue ? 'fix' : 'document', id: `doc:${d.id}`, applicationId: d.applicationId,
        loanNumber: d.loanNumber || null, property: propLabelOf(d.propertyAddress),
        label: scrubText(d.label),
        hint: isIssue && d.rejectionReason ? `Needs a fix: ${scrubText(d.rejectionReason)}` : scrubText(d.hint || ''),
        priority: isIssue ? 1 : 2, route: `/app/${d.applicationId}`,
        dueDate: d.dueDate || null, required: d.required !== false,
      });
    }
    items.sort((a, b) => a.priority - b.priority);
    const counts = {
      total: items.length,
      toSign: items.filter((i) => i.kind === 'sign').length,
      toFix: items.filter((i) => i.kind === 'fix').length,
      toProvide: items.filter((i) => i.kind === 'document').length,
    };
    res.json({ items, counts });
  } catch (e) {
    console.warn('[borrower] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// Borrower requests draw setup on a FUNDED file. Notifies the assigned loan team
// (in-app + email), emails the draws desk + borrower, and confirms in-app.
router.post('/applications/:id/request-draw', async (req, res) => {
  const own = await db.query(
    `SELECT a.id,a.status,a.property_address,a.ys_loan_number,a.loan_officer_id,a.processor_id,
            a.draw_setup_requested_at,
            b.first_name,b.last_name,b.email
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.id=$1 AND (${OWN_FILE_SQL("a", "$2")})`, [req.params.id, me(req)]);
  const a = own.rows[0];
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status !== 'funded') return res.status(400).json({ error: 'Draws can be requested once your loan is funded.' });
  // ONE request per file (owner-directed 2026-07-14): repeat clicks used to
  // fan out the full email set every time. The atomic claim below wins exactly
  // once — every later call answers ok/already with the original timestamp and
  // sends NOTHING.
  const claim = await db.query(
    `UPDATE applications SET draw_setup_requested_at=now(), updated_at=now()
      WHERE id=$1 AND draw_setup_requested_at IS NULL RETURNING draw_setup_requested_at`, [a.id]);
  if (!claim.rows[0]) {
    return res.json({ ok: true, already: true, requestedAt: a.draw_setup_requested_at });
  }
  // BIRTH of the Sitewire draw integration for this file (research doc §4.6): the
  // funded + Request-a-draw click is what pushes the property + budget into Sitewire.
  // Self-gated (no-op unless SITEWIRE_ENABLED) so it's inert until turned on.
  enqueueSitewirePush(a.id, 'push_file').catch(() => {});
  const addr = (a.property_address && (a.property_address.oneLine || a.property_address.line1 || a.property_address.street)) || 'your property';
  const borrowerName = `${a.first_name || ''} ${a.last_name || ''}`.trim();
  try {
    await notify.notifyAppStaff(a.id, {   // #113: whole team (primary + assistants)
        type: 'draw_request', title: 'Draw setup requested',
        body: `${borrowerName || 'The borrower'} requested draw setup on ${addr}.`,
        applicationId: a.id, link: `/internal/app/${a.id}`, ctaLabel: 'Open the file' });
    await notify.notifyBorrower(me(req), {
      type: 'draw_request', title: 'Draw request received',
      body: `We received your request to set up draws on ${addr}. Our draws team will follow up.`,
      applicationId: a.id, link: `/app/${a.id}` });
    // Branded email to the draws DESK ONLY (draws@yscapgroup.com) — a shared inbox
    // that has no PILOT account, so it can't receive the in-app/notify email above.
    // The assigned team and the borrower are NOT re-added here: they already got
    // their branded notification via notifyAppStaff / notifyBorrower, and adding
    // them to this deliver would DOUBLE-email every one of them (owner-reported
    // duplicate-notification sweep 2026-07-20). A reply to the desk email still
    // reaches the whole assigned team via the per-file reply-to.
    await mail.deliver(mail.drawRequest({ borrowerName, propertyLabel: addr, loanNumber: a.ys_loan_number }),
      ['draws@yscapgroup.com'], { replyTo: fileReplyTo(a.id) });   // #68 per-file reply-to
  } catch (e) { /* in-app notice already written; email is best-effort */ }
  await audit(req, 'request_draw', 'application', a.id);
  res.json({ ok: true });
});

// A free-typed vesting entity (name only, never picked from the list) still
// becomes a real profile LLC: match one of the borrower's entities by name,
// else create it — so the file always links a real entity and the LLC
// condition never has to re-ask for a name the borrower already gave.
async function resolveEntityByName(borrowerId, name) {
  const nm = String(name || '').trim().slice(0, 160);
  if (!nm) return null;
  const hit = await db.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, nm]);
  if (hit.rows[0]) return hit.rows[0].id;
  try {
    const ins = await db.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, nm]);
    try { await generateLlcChecklist(ins.rows[0].id); } catch (_) { /* best-effort */ }
    return ins.rows[0].id;
  } catch (e) {
    // Lost a race (or matched a whitespace-variant of an existing name) on the
    // uq_llcs_borrower_name unique index (db/082) — re-select the winner so the
    // file still links a real entity instead of silently failing.
    if (e && e.code === '23505') {
      const again = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))=lower(btrim($2)) LIMIT 1`, [borrowerId, nm]);
      if (again.rows[0]) return again.rows[0].id;
    }
    throw e;
  }
}

router.post('/applications', async (req, res) => {
  const b = req.body || {};
  if (!b.propertyAddress) return res.status(400).json({ error: 'propertyAddress required' });
  if (b.llcId) { const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]); if (!o.rows[0]) b.llcId = null; }
  if (!b.llcId && b.entityName) { try { b.llcId = await resolveEntityByName(me(req), b.entityName); } catch (_) { /* best-effort */ } }
  // Assignment invariant (mirrors the staff create, #96): the ticked flag is the
  // truth; underlying/fee are hard-nulled off an assignment, and the stored
  // purchase price is the underlying + the (derived) fee so leverage/pricing
  // size off seller price + fee and the record is internally consistent.
  const asg = require('../lib/fields').assignmentFields(b);
  const sqf = require('../lib/fields').sqftForType(b.rehabType, intField(b.sqftPre) || null, intField(b.sqftPost) || null);
  const r = await db.query(
    `INSERT INTO applications
       (borrower_id,llc_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_name,
        rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
        is_assignment,underlying_contract_price,assignment_fee,source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'portal',$22,'new',now()) RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, require('../lib/fields').sanitizeLoanType(b.loanType), asg.purchasePrice, b.asIsValue || null,   // #95: never a program
     b.arv || null, b.rehabBudget || null, b.loanOfficerName || null,
     b.rehabType || null, sqf.sqftPre, sqf.sqftPost,
     intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
     asg.isAssignment, asg.underlying, asg.assignFee, JSON.stringify(redactPII(b))]);
  const appId = r.rows[0].id;
  // Invariant chokepoint (root fix 2026-07-14) — inputs derive from the saved row.
  await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'borrower_create' });
  // Auto-apply the saved appraisal card to this new file (no tap) when the
  // borrower previously chose "save to next file". Best-effort; never blocks.
  try { await apprCard.autoApplySavedCardIfOptedIn(appId, me(req)); } catch (_) {}
  await audit(req, 'create_application', 'application', appId);
  // Create + link the ClickUp task in the correct folder on file-start (#92).
  require('../clickup/orchestrator').createForNewFile(appId).catch((e) => console.error('[clickup] create-on-start (apply)', appId, e && e.message));
  res.status(201).json({ ok: true, applicationId: appId });
});

router.get('/applications/:id', async (req, res) => {
  const r = await db.query(
    `SELECT a.*, l.llc_name, l.is_verified AS llc_verified, l.formation_state AS llc_formation_state,
            cb.first_name AS co_borrower_first_name, cb.last_name AS co_borrower_last_name,
            pr.program AS registered_program, pr.product_label AS registered_product_label,
            pr.status AS registered_product_status, pr.note_rate AS registered_note_rate,
            pr.total_loan AS registered_total_loan, pr.quote AS registered_quote,
            pr.created_at AS registered_at,
            EXISTS(SELECT 1 FROM staff_users s
                    WHERE s.id IN (a.loan_officer_id, a.processor_id)
                      AND s.last_seen_at > now() - interval '2 minutes') AS team_online
       FROM applications a
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN LATERAL (
         SELECT program, product_label, status, note_rate, total_loan, quote, created_at
           FROM product_registrations
          WHERE application_id=a.id AND is_current
          ORDER BY created_at DESC LIMIT 1
       ) pr ON true
      WHERE a.id=$1 AND (${OWN_FILE_SQL("a", "$2")}) AND a.deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  // SECURITY / privacy: this is a borrower-facing response built from SELECT a.*,
  // so strip every internal/staff-only column before sending. Above all `lender`
  // is the capital-partner / note-buyer name, which must NEVER reach a borrower
  // surface (frozen session rule); also drop ClickUp/sync internals and the
  // staff-only pipeline detail fields.
  res.json(stripInternalAppFields(r.rows[0]));
});

// #100: the borrower sees THEIR loan officer's contact details on their file
// (not generic company info). Returns the FILE's assigned officer contact, or
// null when the file is still at Lead Capture (client falls back to the company
// contact). Only the borrower/co-borrower on the file may read it.
router.get('/applications/:id/officer', async (req, res) => {
  const own = await db.query(
    `SELECT loan_officer_id FROM applications
      WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`,
    [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const oid = own.rows[0].loan_officer_id;
  if (!oid) return res.json({ officer: null });
  const r = await db.query(
    `SELECT full_name, title, email, phone, cell, nmls FROM staff_users WHERE id=$1 AND is_active=true`,
    [oid]);
  res.json({ officer: r.rows[0] || null });
});

// Columns on `applications` that must never be returned to a borrower.
const BORROWER_HIDDEN_APP_FIELDS = [
  // raw_intake is the ORIGINAL submission blob — on a joint file it carries the
  // OTHER borrower's personal info (the primary's DOB/address/phone typed at
  // submit). The structured fields the portal needs are returned separately, so
  // the raw blob never needs to reach a borrower (S1-03). Not used by the app.
  'raw_intake',
  'lender', 'investor_loan_number', 'channel', 'clickup_extra',
  'clickup_pipeline_task_id', 'clickup_folder_id', 'clickup_list_id',
  'internal_status', 'sync_state', 'sync_status', 'clickup_last_synced_at', 'clickup_status_updated_at', 'hot_poll_until',
  'clickup_created_at', 'clickup_shadow', 'clickup_shadow_hash', 'co_borrower_task_id', 'draw_setup_requested_at',
  // staff-only pipeline detail pulled from ClickUp (Round 3)
  'title_company', 'title_company_contact', 'insurance_company', 'insurance_company_contact',
  'appraiser_name', 'cda_value', 'first_lien', 'second_lien', 'actual_rate', 'desired_rate',
  'encompass_status', 'application_submitted', 'prepayment_penalty', 'property_taxes',
  'property_insurance', 'property_hoa', 'rental_income', 'appraised_rental_value', 'approx_appraised_rental_value',
  // INTERNAL pricing margin + internal valuations — a borrower may see their loan
  // structure but never OUR markup or the internal appraised figures.
  'file_markup_std_pct', 'file_markup_gold_pct', 'actual_appraised_value', 'approx_appraised_value',
  // staff identities + the structural-unlock bookkeeping (owner-directed funded lock).
  'underwriter_id', 'processor_id', 'structural_unlocked_at', 'structural_unlocked_by', 'structural_unlock_reason',
  // stored card fields (currently populated elsewhere, but never leak them from here).
  'card_number_encrypted', 'card_cvv_encrypted', 'card_last4', 'card_exp',
];
// A denylist over SELECT a.* "fails open": a NEW internal column leaks by default
// until someone remembers to add it. This pattern catch-all removes anything whose
// name matches a clearly-internal convention, so a future column can't silently
// reach a borrower. None of these patterns can hit a borrower-facing field.
const INTERNAL_FIELD_PATTERN = /(_encrypted$|^card_|^clickup_|_task_id$|^sync_|_synced_at$|markup|underwriter|structural_unlock|encompass|^cda_|_lien$)/i;
function stripInternalAppFields(row) {
  if (!row || typeof row !== 'object') return row;
  for (const k of BORROWER_HIDDEN_APP_FIELDS) delete row[k];
  for (const k of Object.keys(row)) if (INTERNAL_FIELD_PATTERN.test(k)) delete row[k];
  // Strip OUR internal margin from the registered product's quote. A borrower
  // may see their loan structure (rate, loan amount, appraised value) but never
  // the markup / fee build-up (S1-03). adminPricing is the internal block.
  if (row.registered_quote && typeof row.registered_quote === 'object' && !Array.isArray(row.registered_quote)) {
    const { adminPricing, ...rest } = row.registered_quote;
    row.registered_quote = rest;
  }
  return row;
}

// Remove our internal lender pricing from anything sent to a borrower (S2-08).
// `adminPricing` is the cost/margin build-up (markup, spread, fee breakdown); the
// stored inputs also carry the markup knobs and the PRIMARY borrower's FICO (which
// a co-borrower must not read). A borrower may see their loan STRUCTURE (rate,
// loan amount, values) but never the markup. Staff pricing is a separate endpoint.
function stripQuoteInternal(q) {
  if (!q || typeof q !== 'object') return q;
  const { adminPricing, ...rest } = q;
  return rest;
}
function stripInputsInternal(inp) {
  if (!inp || typeof inp !== 'object') return inp;
  const { markupStdPct, markupGoldPct, fico, ...rest } = inp;
  return rest;
}
// Make a full quoteAll bundle ({inputs, standard, gold}) borrower-safe.
function borrowerSafeQuoteBundle(out) {
  if (!out || typeof out !== 'object') return out;
  return { ...out, inputs: stripInputsInternal(out.inputs),
    standard: stripQuoteInternal(out.standard), gold: stripQuoteInternal(out.gold) };
}

// Scrub capital-partner names out of an LLC bundle's document slots before it
// reaches a borrower: label/hint COALESCE to the INTERNAL wording (llc.js) and
// rejection_reason is staff free-text. Mutates + returns the bundle (a fresh
// object from getLlcBundle).
function scrubLlcSlots(bundle) {
  if (!bundle) return bundle;
  // S2-11: staff identity is internal — the borrower must not see WHICH staffer
  // verified the entity or reviewed each document. Drop verified_by (staff uuid)
  // from the bundle and reviewed_by_name from every slot. Also drop the ClickUp
  // sync internals (getLlcBundle uses SELECT *), matching the track-record scrub.
  // (getLlcBundle is shared with the staff panel, which keeps these — this scrub
  // is the borrower path.)
  delete bundle.verified_by;
  delete bundle.source_task_id;
  delete bundle.origin;
  if (Array.isArray(bundle.slots)) {
    bundle.slots = bundle.slots.map((s) => {
      const out = scrubFields(s, ['label', 'hint', 'rejection_reason']);
      delete out.reviewed_by_name;
      return out;
    });
  }
  return bundle;
}

async function loadFileForPricing(appId, borrowerId) {
  const a = await db.query(
    // Pricing FICO = the HIGHEST score across the file's borrowers (#99): with a
    // co-borrower, the stronger credit prices the deal. NULL when neither has one.
    `SELECT a.*, NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
      WHERE a.id=$1 AND (${OWN_FILE_SQL("a", "$2")}) AND a.deleted_at IS NULL`,
    [appId, borrowerId]);
  const app = a.rows[0];
  if (!app) return null;
  // The file's experience for pricing = BOTH borrowers on it, summed (#80).
  // This is an aggregate count feeding the frozen pricing engine — it exposes
  // no individual deal detail of the other borrower.
  const expBorrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const tr = await db.query(
    `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
       FROM track_records WHERE borrower_id = ANY($1::uuid[]) AND is_verified=true AND (${RECENT_EXIT_SQL}) GROUP BY 1`, [expBorrowerIds]);
  const verified = { flips: 0, holds: 0, ground: 0 };
  for (const row of tr.rows) {
    if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) verified.ground += row.n;
    else if (row.dt.indexOf('flip') > -1) verified.flips += row.n;
    else verified.holds += row.n;
  }
  // Owner-directed 2026-07-14: SIZE the loan on the borrower's CLAIMED experience
  // of record (requested_exp_*), matching the Term Sheet Studio (requested_exp ??
  // verified). Funding stays gated by the experience CONDITION until the claim is
  // VERIFIED, so it never over-lends — it only keeps the registered loan from
  // landing below the number the studio showed. (Same change as the staff pricing
  // loader.)
  const claimed = (v, fb) => (v != null ? (Number(v) || 0) : fb);
  const exp = {
    flips:  claimed(app.requested_exp_flips,  verified.flips),
    holds:  claimed(app.requested_exp_holds,  verified.holds),
    ground: claimed(app.requested_exp_ground, verified.ground),
  };
  return { app, exp };
}

// The borrower may only pass the scenario knobs the Term Sheet Studio lets a
// borrower choose (leverage, term, reserve, estimated FICO and requested
// experience). Deal economics (price / values / budget / state) always come
// from the loan file itself, so a tampered client can't inject a fabricated
// basis. Every value is coerced + clamped to the studio's own input ranges.
function borrowerPricingOverrides(raw) {
  const out = {};
  const clamp = (v, lo, hi) => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  const targetLTC = Number(raw && raw.targetLTC);
  if (isFinite(targetLTC) && targetLTC > 0) out.targetLTC = targetLTC;
  // An explicit blank clears the reserve: pass '' through so buildInputs resolves
  // it to 0 (its blank-clears contract). Dropping the blank left the prior reserve
  // sticking, so a borrower couldn't zero it on re-register (final audit 2026-07-17).
  if (raw && raw.irMonths === '') { out.irMonths = ''; }
  else if (raw && raw.irMonths != null) { const v = clamp(raw.irMonths, 0, 24); if (v != null) out.irMonths = Math.round(v); }
  // Interest reserve may instead be an exact dollar amount (the engine caps it at
  // the loan term). 0 is allowed and clears any prior amount → months path.
  if (raw && raw.irAmount != null && raw.irAmount !== '') { const v = clamp(raw.irAmount, 0, 100000000); if (v != null) out.irAmount = Math.round(v); }
  if (raw && raw.term != null && raw.term !== '') { const v = clamp(raw.term, 1, 36); if (v != null) out.term = Math.round(v); }
  if (raw && raw.fico != null && raw.fico !== '') { const v = clamp(raw.fico, 300, 850); if (v != null) out.fico = Math.round(v); }
  for (const k of ['expFlips', 'expHolds', 'expGround']) {
    if (raw && raw[k] != null && raw[k] !== '') { const v = clamp(raw[k], 0, 999); if (v != null) out[k] = Math.round(v); }
  }
  return out;
}
// SECURITY (audit S1-04, owner-directed 2026-07-12): the borrower-side "admin
// pricing unlock" was REMOVED. A borrower session may only ever send the safe,
// clamped knobs from borrowerPricingOverrides() — never the staff-grade
// fee / markup / manual-basis overrides (markup%, origination, lender/credit/
// appraisal/title fees, manual LTV/rate). Those belong only to the staff pricing
// routes (loan officer / processor / admin), gated by staff auth. There is no
// longer any adminKey path a borrower can present, and no hardcoded key.

router.get('/applications/:id/pricing', async (req, res) => {
  try {
    const f = await loadFileForPricing(req.params.id, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const hist = await db.query(
      `SELECT r.id, r.program, r.product_label, r.status, r.note_rate, r.total_loan, r.target_ltc,
              r.is_current, r.created_at, r.inputs, r.quote, r.term_options, s.full_name AS registered_by_name
         FROM product_registrations r LEFT JOIN staff_users s ON s.id=r.registered_by
        WHERE r.application_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    // Strip internal lender pricing (markup/spread) from anything sent to a
    // borrower — a staff-created registration's quote AND inputs embed it. The
    // rest of `inputs` is the borrower's own registered scenario (price, values,
    // budget, FICO, experience, term, reserve) — that's what the "Scenario as
    // registered" panel renders from.
    const redactRow = (row) => row ? { ...row, quote: stripQuoteInternal(row.quote), inputs: stripInputsInternal(row.inputs) } : row;
    const history = hist.rows.map(redactRow);
    const current = history.find((x) => x.is_current) || null;
    let quote = null;
    // The live what-if quote embeds adminPricing too — strip it before it leaves.
    if (pricing.enginesReady()) { try { quote = borrowerSafeQuoteBundle(pricing.quoteAll(f.app, f.exp)); quote.experience = f.exp; } catch (_) {} }
    // If the borrower's registration is a manual-review exception waiting on a
    // super-admin, surface that state so the studio shows "registered but NOT
    // confirmed — waiting for approval" on reload (not just the transient submit
    // toast). Mirror the staff GET: pending row first, else the latest decided.
    let manualEscalation = null;
    try {
      // Borrower-safe: status only — never the internal summary/leverage/asset
      // months or a super-admin's decision note.
      const d = await db.query(
        `SELECT status FROM manual_program_escalations
          WHERE application_id=$1 ORDER BY (status='pending') DESC, created_at DESC LIMIT 1`, [req.params.id]);
      manualEscalation = d.rows[0] || null;
    } catch (_) {}
    // Echoed back on register — a mismatch means the file's economics moved
    // underneath the open studio (409, never a silent stale re-register).
    res.json({ current, history, quote, enginesReady: pricing.enginesReady(), econVersion: pricing.econVersionFor(f.app), manualEscalation });
  } catch (e) { console.error('[borrower pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.post('/applications/:id/pricing/quote', async (req, res) => {
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadFileForPricing(req.params.id, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const overrides = borrowerPricingOverrides((req.body && req.body.overrides) || {});
    const out = borrowerSafeQuoteBundle(pricing.quoteAll(f.app, f.exp, overrides));
    res.json({ ...out, experience: f.exp });
  } catch (e) { console.error('[borrower pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.post('/applications/:id/pricing/register', async (req, res) => {
  const appId = req.params.id;
  // Refusals are audited (register_product_refused) so "register didn't work"
  // is diagnosable from the logs alone (#148/#149) — same as the staff route.
  const refuse = async (status, payload, reason, extra) => {
    try { await audit(req, 'register_product_refused', 'application', appId, { reason, status, ...extra }); } catch (_) {}
    return res.status(status).json(payload);
  };
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const locked = await require('../lib/file-lock').structuralLockReason(appId);   // #84
    if (locked) return refuse(409, { error: locked }, 'structural_lock');
    const f = await loadFileForPricing(appId, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    // Same optimistic-concurrency guard as the staff route (#148): a stale
    // studio session must never re-register economics the file no longer has.
    if (b.econVersion && b.econVersion !== pricing.econVersionFor(f.app)) {
      return refuse(409, {
        error: 'This file’s pricing inputs changed since the studio was opened. The latest values have been reloaded — review the scenario and register again.',
        code: 'econ_version_conflict',
      }, 'econ_version_conflict', { sent: String(b.econVersion).slice(0, 32) });
    }
    const program = b.program === 'gold' ? 'gold' : 'standard';
    const overrides = borrowerPricingOverrides(b.overrides || {});
    // A REGISTERED product is authoritative terms. Never let borrower-claimed
    // experience beat the verified track record here — staff loan officers are
    // forbidden from injecting these same keys (ADMIN_ONLY_OVERRIDE_KEYS), so a
    // borrower (least privileged) must not be able to either. The what-if /quote
    // path may keep them; the registered basis uses verified experience only.
    delete overrides.expFlips; delete overrides.expHolds; delete overrides.expGround;
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    // Term-sheet options (owner-directed 2026-07-22) — display/record only. A
    // borrower self-registers Standard/Gold only (never manual), so min-interest
    // defaults OFF here unless explicitly set.
    const rawTermOptions = (b.termOptions && typeof b.termOptions === 'object') ? b.termOptions : {};
    // Effective closing date = studio's, else the file's existing — so a re-register
    // never wipes the dates and they re-derive when the term moves.
    const closingForDates = rawTermOptions.estClosingDate || f.app.est_closing_date || f.app.expected_closing || null;
    const kd = termOpts.keyDates(closingForDates, inputs.term);
    const resolvedTermOptions = {
      accrualType: termOpts.resolveAccrual(rawTermOptions.accrualType),
      minInterestEnabled: termOpts.resolveMinInterest(program, rawTermOptions.minInterestEnabled),
      deferredOrigPct: termOpts.resolveDeferredOrigPct(rawTermOptions.deferredOrigPct),
      estClosing: kd.estClosing, firstPayment: kd.firstPayment, maturity: kd.maturity,
      // The co-borrower guaranty waiver is a super-admin-APPROVED file flag, never a
      // studio input — snapshot the file's REAL value (ignore any client-sent value).
      coBorrowerPgWaived: !!f.app.co_borrower_pg_waived,
    };
    const quote = pricing.quoteProgram(program, inputs);
    // Gold Standard renovation cannot finance an interest reserve — never persist a
    // requested reserve on the registered scenario for that program.
    // Gold renovation finances NO interest reserve — zero BOTH request forms (see the
    // matching note in staff.js; audit findings #14/#34/#40/#49, 2026-07-17).
    if (program === 'gold' && quote.kind === 'reno') { inputs.irMonths = 0; inputs.irAmount = 0; }
    if (quote.status === 'INELIGIBLE') return refuse(422, { error: 'ineligible', reasons: quote.reasons, quote: stripQuoteInternal(quote) }, 'ineligible', { program });
    const total = quote.sizing ? quote.sizing.totalLoan : 0;
    if (!(total > 0)) return refuse(422, { error: 'no loan sized', quote: stripQuoteInternal(quote) }, 'no_loan_sized', { program });

    // Owner-directed 2026-07-21: a MANUAL result is NOT eligible as-is — it is a
    // manual-review EXCEPTION (below the $100,000 minimum, over the maximum, or any
    // other guideline exception the engine flags). A borrower can NEVER self-confirm
    // such terms: block the plain register (the portal then offers "Submit exception
    // request") and, only when they explicitly submit the exception, register it as
    // pending and open a super-admin escalation. The borrower is not sent terms
    // unless a super-admin approves it.
    const submitException = !!b.submitException;
    const manualReasons = (quote.reasons || [])
      .filter((r) => r && r.level === 'MANUAL').map((r) => r.msg).filter(Boolean);
    if (quote.status === 'MANUAL' && !submitException) {
      return refuse(422, {
        error: 'exception_required',
        code: 'exception_required',
        message: `This scenario isn’t eligible as-is on the ${pricing.PROGRAM_LABEL[program]}. It needs a manual-review exception: ${manualReasons.join('; ') || 'a guideline exception'}. Submit an exception request and your loan team will review it — you won’t receive terms unless it’s approved.`,
        reasons: quote.reasons, quote: stripQuoteInternal(quote),
        exceptionRequired: true, manualReasons,
      }, 'exception_required', { program, manualReasons });
    }
    const needsEscalation = manualProgram.needsSuperAdminApproval({ program, status: quote.status });

    // Superseded terms, captured before the new registration lands — so the
    // audit trail / Activity feed can say exactly what the reprice changed.
    const prevQ = await db.query(
      `SELECT program, total_loan, note_rate, product_label FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    const prev = prevQ.rows[0] || null;

    const client = await db.getClient();
    let regId;
    let economicsChanged = true;   // first registration always confirms to the borrower
    let loanAmountChanged = false;   // loan amount moved → auto-clear a signed Heter Iska
    try {
      await client.query('BEGIN');
      const reg = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: null,
        termOptions: resolvedTermOptions,
      });
      regId = reg.id;
      economicsChanged = reg.economicsChanged;
      loanAmountChanged = reg.loanAmountChanged;
      // A borrower-submitted exception (MANUAL) opens a super-admin escalation and
      // stays pending until approved; a clean product closes any stale escalation.
      if (needsEscalation) {
        await manualProgram.openEscalation(client, {
          appId, registrationId: regId, assetMonths: null, overrides: {},
          summary: {
            kind: 'manual_review', program, status: quote.status,
            totalLoan: total, noteRate: quote.noteRate,
            acqLtvPct: quote.sizing ? quote.sizing.acqLtvPct : null,
            arvPct: quote.sizing ? quote.sizing.arvPct : null,
            ltcPct: quote.sizing ? quote.sizing.ltcPct : null,
            manualReasons, requestedByBorrower: true,
            minInterest: resolvedTermOptions.minInterestEnabled,
            minInterestDefault: termOpts.defaultMinInterest(program),
            accrual: resolvedTermOptions.accrualType,
          },
          requestedBy: null,
        });
      } else {
        await manualProgram.closePendingForApp(client, appId);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    // Vesting LLC on register (owner-directed 2026-07-21): a typed entity name
    // on the studio should be persisted as the subject-property LLC on the file.
    // Only fills a file that has no vesting LLC yet — never renames an existing
    // one. Best-effort.
    try {
      const b2 = req.body || {};
      const typed = String((b2.overrides && b2.overrides.entityName) || b2.entityName || '').trim();
      const cur = (await db.query(`SELECT llc_id, borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {};
      if (typed && !cur.llc_id && cur.borrower_id) {
        const vestLlcId = await resolveEntityByName(cur.borrower_id, typed);
        if (vestLlcId) await require('../lib/vesting').setVestingLlc(appId, vestLlcId, { source: 'borrower', actor: null });
      }
    } catch (e) { console.error('[borrower-register] vesting from studio failed:', db.describeError(e)); }
    // Registration rewrites loan amount / rate / program — re-run condition rules.
    try { await conditionEngine.evaluateApplication(appId, { reason: 'product_registered' }); } catch (_) {}
    // Replace the generic bank-statement condition with the detailed liquidity
    // requirement from the freshly-registered quote — same as the staff register
    // path (#85). Without this a borrower-registered product left no breakdown and
    // never reopened on a later increase.
    try { await require('../lib/liquidity').syncLiquidityCondition(appId, quote); } catch (_) {}
    // Gold Standard Program requires a 5% SOW contingency: reopen the rehab-budget
    // condition (even if already signed off) with a FATAL note when the saved
    // Scope of Work is missing it.
    try { await require('../lib/rehab-budget').enforceGoldSowContingency(appId); } catch (_) {}
    // Loan amount moved → auto-clear a signed Heter Iska (tied to the loan amount).
    if (loanAmountChanged) {
      try {
        await require('../lib/esign/iska-autoclear').autoClearIskaOnLoanChange({
          appId, actorId: null, db, docusign: require('../lib/integrations/docusign'),
        });
      } catch (e) { console.warn('[borrower-register] ISKA auto-clear failed:', db.describeError(e)); }
    }

    // Push the freshly-committed scenario (loan amount, rate, rehab, term, IR,
    // ARV / as-is / purchase, assignment, desired rate) to ClickUp immediately.
    require('../clickup/orchestrator').pushApplication(appId).catch((e) => console.error('[clickup] push after register (borrower)', appId, e && e.message));

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null,
        origination: quote.origination != null ? quote.origination : undefined,
        cashToClose: quote.cashToClose != null ? quote.cashToClose : undefined,
        liquidity: (quote.liquidity ?? quote.liquidityRequired) != null ? (quote.liquidity ?? quote.liquidityRequired) : undefined,
        previous: prev ? { program: prev.program, totalLoan: Number(prev.total_loan), noteRate: Number(prev.note_rate), productLabel: prev.product_label } : undefined });

    // (Re-)registering resets the "Products & pricing" condition to received and
    // CLEARS any prior sign-off — a borrower re-register can change term/program/
    // structure that no trigger-watched column reflects (e.g. same loan amount,
    // only rate moved), so staff must re-verify the new structure. Unconditional,
    // mirroring the db/096 trigger's reopen semantics (audit #26/#58).
    try {
      await db.query(
        `UPDATE checklist_items
            SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE application_id=$1 AND tool_key='product_pricing'`, [appId]);
    } catch (_) { /* condition may not exist on older files */ }

    try {
      const t = await db.query(`SELECT loan_officer_id, processor_id, ys_loan_number FROM applications WHERE id=$1`, [appId]);
      const row = t.rows[0] || {};
      const rate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : 'n/a';
      const sz = quote.sizing || {}, ccQ = quote.closingCosts || {};
      const ctx = await notify.fileContext(appId, [
        { label: 'Registered product', value: [quote.programLabel, quote.productLabel].filter(Boolean).join(' - ') || pricing.PROGRAM_LABEL[program] },
        { label: 'Total loan', value: `${money(total)} @ ${rate}` },
        sz.initialAdvance != null ? { label: 'Initial advance / holdback', value: `${money(sz.initialAdvance)} / ${money(sz.rehabHoldback)}` } : null,
        sz.downPayment != null ? { label: 'Down payment', value: money(sz.downPayment) } : null,
        quote.cashToClose != null ? { label: 'Cash to close', value: money(quote.cashToClose) } : null,
        (quote.liquidity ?? quote.liquidityRequired) != null ? { label: 'Liquidity to verify', value: money(quote.liquidity ?? quote.liquidityRequired) } : null,
        sz.ltcPct != null ? { label: 'LTC / LTV / ARV', value: `${(sz.ltcPct * 100).toFixed(1)}% / ${(sz.acqLtvPct * 100).toFixed(1)}% / ${(sz.arvPct * 100).toFixed(1)}%` } : null,
      ].filter(Boolean));
      const body = `${pricing.PROGRAM_LABEL[program]} registered by the borrower on ${ctx ? ctx.label : (row.ys_loan_number || 'a file')}: ${money(total)} @ ${rate} · cash to close ${money(quote.cashToClose)} · liquidity to verify ${money(quote.liquidity ?? quote.liquidityRequired)}.`;
      await notify.notifyAppStaff(appId, {   // #113: whole team (primary + assistants)
          type: 'product_registered',
          title: 'Borrower registered a product',   // identity rides in the subject tag (loan# · borrower · property) — not the title
          body, applicationId: appId, meta: (ctx && ctx.meta) || undefined,
          link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file',
        });
      // The borrower gets the SAME rich, borrower-safe loan-terms email as on the
      // staff register path — but ONLY when (a) a headline number actually changed
      // (owner-directed 2026-07-20 — a same-numbers re-register is a no-op) AND
      // (b) the registration does NOT need super-admin approval (owner-directed
      // 2026-07-21 — a manual-review exception is confirmed to the borrower ONLY
      // after a super-admin approves it). The team notice above always fires.
      if (economicsChanged && !needsEscalation) {
        try { await require('../lib/terms-notify').sendBorrowerTerms(appId, { quote, total, termMonths: inputs && inputs.term }); }
        catch (_) { /* borrower terms email is best-effort */ }
      }
      // Borrower submitted a manual-review exception → alert the admins/super-admins
      // that it's waiting in the Escalations box AND raise it into the super-admin
      // Workflow (best-effort).
      if (needsEscalation) {
        try {
          await notify.notifyAdmins({
            type: 'manual_escalation',
            title: 'Exception request needs super-admin approval',
            body: `The borrower submitted a ${pricing.PROGRAM_LABEL[program]} exception request on ${ctx ? ctx.label : (row.ys_loan_number || 'a file')} (${manualReasons.join('; ') || 'guideline exception'}) — it’s waiting for super-admin approval in the Escalations box. No terms are sent unless it’s approved. Loan amount ${money(total)}.`,
            meta: (ctx && ctx.meta) || undefined, applicationId: appId,
            link: '/internal/escalations', ctaLabel: 'Open the Escalations box',
          });
        } catch (_) { /* best-effort */ }
        try {
          const wfNote = `${pricing.PROGRAM_LABEL[program]} — borrower exception request: ${manualReasons.join('; ') || 'guideline exception'}. ${money(total)}. Review and approve/decline it in the Escalations box.`;
          await workflowAuto.onEscalationOpened(appId, { fromStaffId: null, note: wfNote });
        } catch (_) { /* best-effort */ }
      } else {
        workflowAuto.closeEscalationWorkflow(appId, 'Re-registered as eligible').catch(() => {});
      }
    } catch (_) {}

    res.status(201).json({ ok: true, registrationId: regId, quote: stripQuoteInternal(quote), pendingApproval: needsEscalation });
  } catch (e) { console.error('[borrower pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// Borrower requests an EXCEPTION to a guideline (e.g. finance more of an
// assignment fee than the 15% cap → a bigger loan). Raises an escalation into the
// super-admin Workflow + Escalations box; does NOT change the registered product
// (owner-directed 2026-07-21). A super-admin reviews and, if granted, applies the
// admin override and re-registers.
router.post('/applications/:id/pricing/request-exception', async (req, res) => {
  const appId = req.params.id;
  try {
    const f = await loadFileForPricing(appId, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const note = String((req.body && req.body.note) || '').slice(0, 1000).trim();
    if (!note) return res.status(400).json({ error: 'Describe the exception you’re requesting.' });
    const ctx = await notify.fileContext(appId);
    await workflowAuto.onEscalationOpened(appId, { fromStaffId: null, note: `Borrower exception request: ${note}` });
    try {
      await notify.notifyAdmins({
        type: 'manual_escalation',
        title: 'Borrower requested an exception',
        body: `The borrower requested an exception on ${ctx ? ctx.label : 'a file'}: ${note}`,
        meta: (ctx && ctx.meta) || undefined, applicationId: appId,
        link: '/internal/escalations', ctaLabel: 'Open the Escalations box',
      });
    } catch (_) { /* best-effort */ }
    await audit(req, 'pricing_exception_requested', 'application', appId, { note });
    res.json({ ok: true });
  } catch (e) { console.error('[borrower pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// Borrower-safe file activity feed (never internal chat/notes/conditions).
router.get('/applications/:id/activity', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  try { res.json(await require('../lib/activity').fileActivity(req.params.id, true)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Borrower-visible conditions (object model) — open/unresolved, borrower wording.
router.get('/applications/:id/conditions', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  // Borrower-facing wording ONLY — never fall back to the internal title/detail
  // (which can carry underwriting / capital-partner context). A borrower/both
  // condition without borrower wording shows a generic placeholder.
  const r = await db.query(
    `SELECT id, COALESCE(borrower_title,'An item your loan team needs') AS title,
            borrower_detail AS detail,
            severity, status, linked_entity_type, linked_entity_id, created_at
       FROM conditions
      WHERE application_id=$1 AND audience IN ('borrower','both') AND status IN ('open','borrower_responded')
      ORDER BY created_at`, [req.params.id]);
  // Scrub any capital-partner name out of borrower-facing wording on the way out
  // — covers already-stored data (e.g. a borrower_title defaulted from an
  // internal title). Staff surfaces are never scrubbed.
  res.json(r.rows.map((row) => ({ ...row, title: scrubText(row.title), detail: scrubText(row.detail) })));
});

// ---------------- APPRAISAL (borrower READ-ONLY: the property report + findings) ----------------
// The borrower SEES the appraisal report and the PILOT findings for transparency, but can
// take NO action on them (the resolve endpoint is staff-only). Findings are trimmed to
// borrower-safe fields — the staff "how to resolve" guidance is never sent, and titles are
// scrubbed of any capital-partner name.
router.get('/applications/:id/appraisal', async (req, res) => {
  const own = await db.query(`SELECT id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const appId = own.rows[0].id;
  const appr = (await db.query(
    `SELECT * FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0];
  if (!appr) return res.json({ appraisal: null, comparables: [], units: [], findings: [], photos: [], summary: { fatal: 0, warning: 0, info: 0, blocksCtc: false } });
  const [comps, units, findings, photos] = await Promise.all([
    db.query(`SELECT * FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY seq`, [appr.id]),
    db.query(`SELECT * FROM appraisal_units WHERE appraisal_id=$1 ORDER BY unit_seq`, [appr.id]),
    db.query(`SELECT id, code, severity, field, appraisal_value, file_value, title, blocks_ctc, created_at
                FROM appraisal_findings WHERE application_id=$1 AND status='open'
               ORDER BY (severity='fatal') DESC, created_at`, [appId]),
    db.query(
      `SELECT ap.id, ap.document_id, ap.category, ap.caption, ap.sequence, ap.width, ap.height
         FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
        WHERE ap.appraisal_id=$1 AND d.is_current AND ap.document_id IS NOT NULL
        ORDER BY ap.sequence`, [appr.id]),
  ]);
  // Underwriting-scrutiny findings are STAFF-ONLY — they reveal how hard the lender is
  // scrutinizing the deal (inflated-ARV signal, value not carried by the comps, over-paying vs
  // as-is). A borrower must never see the lender's internal skepticism, so these codes are
  // dropped from the borrower set entirely (they stay open + visible on the staff desk).
  const SCRUTINY_CODES = new Set(['arv_defensibility', 'value_vs_comps', 'value_not_bracketed', 'asis_below_price', 'comp_split_review']);
  const open = findings.rows
    .filter((f) => !SCRUTINY_CODES.has(f.code))
    .map((f) => ({ ...f, title: scrubText(f.title) }));
  // A hidden scrutiny finding can still be a REAL clear-to-close blocker (asis_below_price is
  // fatal). We must not tell the borrower their file is clear while it's actually gated — but we
  // also can't reveal the underwriting reason. If a filtered-out finding is a live blocker, surface
  // ONE neutral placeholder so the borrower's summary honestly shows "under review", not "clear".
  const hiddenBlocker = findings.rows.some((f) => SCRUTINY_CODES.has(f.code) && f.severity === 'fatal' && f.blocks_ctc);
  if (hiddenBlocker) {
    open.push({ id: 'appraisal_review', code: 'appraisal_under_review', severity: 'fatal', field: 'value',
      appraisal_value: null, file_value: null, blocks_ctc: true, created_at: null,
      title: 'Your appraisal is in final underwriting review' });
  }
  // Borrower-safe appraisal object: drop staff-only bookkeeping (who imported it, the
  // source document ids) AND the free-text lender/AMC/client fields OUTRIGHT — a capital-partner
  // name can never reach a borrower. Scrubbing a free-text field only strips the names we know;
  // dropping the columns removes the whole class (the borrower UI never reads lender/AMC).
  const safeAppr = (() => {
    if (!appr) return null;
    // Also drop the `fields` jsonb catch-all: it carries appraiser.lender/appraiser.amc
    // UN-scrubbed (buildFieldsJson), which would defeat the column drop below. The borrower
    // UI never reads it, so dropping it entirely is the safe, clean fix.
    // owner_of_record + lender_address are STAFF-ONLY (db/158) — drop them like lender_name/amc_name
    // so they never reach the borrower JSON, even though the UI doesn't render them.
    // `warnings` is the parser's raw underwriting-scrutiny array (comp_split_review, nbhd_declining,
    // sale_type_risk, mc_*, etc.) — the SAME class the SCRUTINY_CODES filter hides from the borrower
    // `findings` list. Drop it too so the scrutiny scrub can't be defeated via the appraisal payload;
    // the borrower gets the filtered `findings`, never the raw warnings.
    // The appraiser's DIRECT CONTACT + supervisor personnel + tooling vendor are internal — the
    // borrower reaches their loan team, never the appraiser directly, so the personal phone/email,
    // firm street address, supervisor identity/license and software vendor are dropped (M9). The
    // "Prepared by" card still shows WHO appraised the property (name/firm/license) — standard
    // appraisal disclosure — but not how to contact them or the internal desk detail.
    const { imported_by, source_xml_document_id, pdf_document_id, fields, warnings,
      lender_name, amc_name, owner_of_record, lender_address,
      appraiser_email, appraiser_phone, appraiser_company_address,
      supervisor_name, supervisor_license_id, supervisor_license_state, supervisor_license_exp,
      software_vendor, ...rest } = appr; // eslint-disable-line no-unused-vars
    return rest;
  })();
  const bSummary = {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocks_ctc),
  };
  // Borrowers see the collateral read (a neutral quality summary of THEIR property) but NOT the
  // ARV-defensibility cross-check — that's an underwriting-scrutiny signal, staff-only.
  // Implied-value cross-check over the operative grid's comps only (never a mix of As-Is + ARV).
  // Pre-split appraisals (no comp_set) keep the old all-comps behavior.
  const gridKey = safeAppr.arv_value != null ? 'arv' : 'as_is';
  const hasSplit = comps.rows.some((c) => c.comp_set);
  const impliedComps = hasSplit ? comps.rows.filter((c) => c.comp_set === gridKey) : comps.rows;
  const score = {
    collateral: apprScore.collateralScore({ a: safeAppr, comps: comps.rows, summary: bSummary }),
    arv: null,
    impliedValue: apprScore.compImpliedValue({ comps: impliedComps, subjectGla: safeAppr.gla }),
  };
  res.json({
    appraisal: safeAppr, comparables: comps.rows, units: units.rows, findings: open, photos: photos.rows,
    summary: bSummary, score,
  });
});

// ---------------- CHECKLIST (borrower-visible items only) ----------------
router.get('/applications/:id/checklist', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  try { await syncExperienceChecklistForApplication(req.params.id); } catch (_) { /* best-effort */ }
  const r = await db.query(
    `SELECT ci.id, COALESCE(ci.borrower_label,'An item your loan team needs') AS label, ci.status, ci.item_kind, ci.phase,
            ci.borrower_hint AS hint, ci.is_required, ci.due_date,
            ci.field_key, ci.esign_doc,
            -- ci.notes is the INTERNAL staff note (underwriting / capital-partner
            -- context) — never send it to a borrower. Only the borrower_* wording
            -- above is safe.
            (SELECT code FROM checklist_templates t WHERE t.id=ci.template_id) AS template_code,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            -- issue_reason is a borrower-SAFE reason (set when staff reject / push
            -- back / raise an issue against a condition) — unlike ci.notes it may be
            -- shown. Fall back to the latest rejected document's reason.
            COALESCE(ci.issue_reason,
              (SELECT d.rejection_reason FROM documents d
                WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
                ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1)) AS rejection_reason
       FROM checklist_items ci
      WHERE ci.application_id=$1 AND ci.audience IN ('borrower','both')
      ORDER BY ci.sort_order, ci.created_at`, [req.params.id]);
  // Info-field conditions carry their field definition (type/options/labels)
  // and the field's current value so the portal can render a typed input.
  const rows = r.rows;
  // Scrub capital-partner names from borrower-facing wording (label/hint/reason)
  // before anything else uses `rows` — covers data where borrower_label was
  // defaulted from the internal label.
  for (const it of rows) { it.label = scrubText(it.label); it.hint = scrubText(it.hint); it.rejection_reason = scrubText(it.rejection_reason); }
  // Co-borrower privacy (#82): personal fields (FICO / citizenship / home state)
  // are per-borrower. loadRuleContext builds them from the PRIMARY borrower, so
  // pre-fill those from the VIEWER's OWN record instead — a co-borrower must
  // never see the primary's FICO, and vice-versa. App/deal fields stay from ctx.
  const BORROWER_SCOPED = new Set(['fico', 'citizenship', 'borrower_state']);
  if (rows.some((it) => it.tool_key === 'info_field' && it.field_key)) {
    let ctx = null;
    try { const loaded = await conditionEngine.loadRuleContext(req.params.id); ctx = loaded && loaded.ctx; } catch (_) {}
    const fieldsByKey = await conditionRegistry.fieldMap(db);
    let selfVals = null;
    if (rows.some((it) => it.tool_key === 'info_field' && BORROWER_SCOPED.has(it.field_key))) {
      try {
        const sb = (await db.query(`SELECT fico, citizenship, current_address FROM borrowers WHERE id=$1`, [me(req)])).rows[0];
        if (sb) selfVals = { fico: sb.fico ?? null, citizenship: sb.citizenship ?? null, borrower_state: (sb.current_address && sb.current_address.state) || null };
      } catch (_) { selfVals = {}; }
    }
    for (const it of rows) {
      if (it.tool_key !== 'info_field' || !it.field_key) continue;
      const f = fieldsByKey[it.field_key];
      if (!f) continue;
      it.field_def = {
        key: f.key, type: f.type, options: f.options || undefined,
        // Borrower-facing field label only — never the internal f.label.
        label: f.borrowerLabel || 'Additional information', hint: f.borrowerHint || undefined,
      };
      it.field_value = BORROWER_SCOPED.has(it.field_key)
        ? (selfVals ? (selfVals[it.field_key] ?? null) : null)
        : (ctx ? (ctx[it.field_key] ?? null) : null);
    }
  }
  // Borrower-safe tool_payload (M8). The raw tool_payload blob is returned so the
  // portal can pre-fill a submitted answer, but as stored it can carry data a
  // borrower — especially a CO-borrower — must not see:
  //   • track_record.perBorrower is EACH borrower's individual REO / financial
  //     breakdown (staff-only + cross-borrower); the borrower view only renders
  //     the aggregate `counts`.
  //   • for a per-borrower personal info field (FICO / citizenship / home state),
  //     tool_payload.value is whoever last answered it (the PRIMARY) — and the UI
  //     reads it in preference to the per-viewer field_value, defeating the #82
  //     scoping. Reflect the VIEWER's own value instead.
  //   • no tool_payload may ever ship our internal pricing build-up.
  for (const it of rows) {
    if (!it.tool_payload || typeof it.tool_payload !== 'object') continue;
    if (it.tool_key === 'track_record') {
      const { perBorrower, liquidity, ...safe } = it.tool_payload; // eslint-disable-line no-unused-vars
      it.tool_payload = safe;
    } else if (it.tool_key === 'info_field' && BORROWER_SCOPED.has(it.field_key)) {
      it.tool_payload = (it.field_value === null || it.field_value === undefined) ? null : { value: it.field_value };
    }
    if (it.tool_payload && typeof it.tool_payload === 'object') {
      const { adminPricing, markupStdPct, markupGoldPct, ...rest } = it.tool_payload; // eslint-disable-line no-unused-vars
      it.tool_payload = rest;
    }
  }
  res.json(rows);
});

// Borrower answers an information condition: the value is written into the
// real application/borrower field (whitelisted in the field registry), the
// condition moves to 'received', and the rule engine re-checks the file.
router.post('/applications/:id/checklist/:itemId/info', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const it = await db.query(
    `SELECT id, field_key, status, borrower_label, label FROM checklist_items
      WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key='info_field'`,
    [req.params.itemId, req.params.id]);
  if (!it.rows[0]) return res.status(404).json({ error: 'information item not found' });
  const item = it.rows[0];
  if (!item.field_key) return res.status(400).json({ error: 'this item is not linked to a field' });
  if ((req.body || {}).value === undefined || req.body.value === null || req.body.value === '')
    return res.status(400).json({ error: 'a value is required' });
  // S5-03: on a REGISTERED file, an economics field answered here is a change to
  // authoritative terms — route it through the approval sandbox instead of writing
  // the live record. Personal/verification fields (FICO, DOB, …) are unaffected.
  if (changeRequests.isGovernedField(item.field_key) && await changeRequests.isBorrowerLocked(req.params.id)) {
    try {
      const cr = await changeRequests.openRequest(req.params.id, item.field_key, req.body.value,
        { reason: req.body.reason || null, requesterKind: 'borrower', requesterId: me(req) });
      if (!cr.unchanged) await notifyTeamOfChangeRequests(req.params.id, [cr]);
      return res.json({ ok: true, locked: true, changeRequested: !cr.unchanged, field: item.field_key });
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message });
    }
  }
  let saved;
  try {
    // Co-borrower privacy (#82): a borrower-scoped field (e.g. FICO) is written to
    // the borrower who is ANSWERING — me(req) — never to the primary. Otherwise a
    // co-borrower answering a FICO condition would overwrite the primary's credit
    // score. App/deal fields ignore this id (they write to the application).
    saved = await conditionEngine.writeFieldValue(req.params.id, me(req), item.field_key, req.body.value,
      { kind: 'borrower', id: me(req) });
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  await db.query(
    `UPDATE checklist_items SET status='received',
            tool_payload=$2, updated_at=now()
      WHERE id=$1`,
    [req.params.itemId, JSON.stringify({ infoField: item.field_key, value: saved.value, submittedAt: new Date().toISOString() })]);
  enqueueChecklistStatusPush(req.params.itemId).catch(() => {}); // mapped conditions → ClickUp dropdown
  await audit(req, 'submit_info_condition', 'checklist_item', req.params.itemId, { fieldKey: item.field_key });
  // Field data changed → the engine may add/retract rule-driven conditions.
  try { await conditionEngine.evaluateApplication(req.params.id, { reason: 'info_condition_answered' }); } catch (_) {}
  // Let the loan team know the borrower provided the info.
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
    const row = a.rows[0];
    if (row) {
      const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppStaff(req.params.id, {   // #113: whole team (primary + assistants)
          type: 'tool_submitted', title: `${who} answered "${item.borrower_label || item.label}"`,
          body: `${ctx ? ctx.label : 'A file'} — the condition is ready for review.`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: req.params.id, link: `/internal/app/${req.params.id}`, ctaLabel: 'Review the file' });
    }
  } catch (_) { /* best-effort */ }
  res.json({ ok: true, status: 'received', value: saved.value });
});

// Borrower-safe loan timeline: which milestones the file has reached and when.
// Only the destination status + date (no staff identity, no forced flag).
router.get('/applications/:id/status-history', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT to_status, created_at FROM application_status_history WHERE application_id=$1 ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});

// Borrower completes a tool-backed task (Rehab Budget / Track Record) inside the
// portal. Stores the exported payload and moves the item to 'received' so staff
// can verify and sign off. The borrower is doing "their part" of the file here.
router.post('/applications/:id/checklist/:itemId/tool', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const it = await db.query(
    `SELECT id,tool_key FROM checklist_items
      WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key IS NOT NULL`,
    [req.params.itemId, req.params.id]);
  if (!it.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  if (it.rows[0].tool_key === 'track_record') {
    const sync = await syncExperienceChecklistForApplication(req.params.id);
    if (!sync || !sync.satisfied) {
      return res.status(422).json({
        error: 'track record requirement is not complete',
        required: sync && sync.required,
        counts: sync && sync.counts,
      });
    }
    return res.json({ ok: true, status: 'received', ...sync });
  }
  const rawPayload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : { submitted: true };
  const stripped = stripToolAttachments(rawPayload);
  const payload = stripped.payload;
  // S2-07: `checklist_items.notes` is the INTERNAL staff/underwriting note — the
  // borrower must never write it. (A borrower-typed `notes` used to overwrite it
  // here.) The borrower's tool data lives in `tool_payload`; the '[auto]' SOW note
  // below is written separately.
  // Scope-of-Work condition logic (owner-directed 2026-07-09). Saving a SOW NEVER
  // changes the file's rehab budget (frozen) and NEVER refuses on a mismatch — the
  // SOW saves as a DRAFT so it can be reopened + adjusted. The exact-match rule is
  // purely a CONDITION gate: the condition stays open (uncleared) for EVERY party
  // and carries a plain-language note until the line items total the budget exactly.
  let sowMismatch = null, goldSow = { ok: true };
  if (it.rows[0].tool_key === 'rehab_budget') {
    // The rehab budget is loan structure — frozen at Clear-to-Close (#84).
    const locked = await require('../lib/file-lock').structuralLockReason(req.params.id);
    if (locked) return res.status(409).json({ error: locked, fatal: true });
    const chk = await require('../lib/rehab-budget').checkSowBudget(req.params.id, payload);
    if (!chk.ok) sowMismatch = { required: chk.required, total: Number(payload && payload.total), message: chk.message };
    // Gold Standard Program: the SOW must carry a >= 5% construction contingency.
    goldSow = await require('../lib/rehab-budget').checkGoldSow(req.params.id, payload);
  }
  // Status: a matching SOW → 'received'; a budget mismatch OR a missing Gold 5%
  // contingency WITH content → 'issue' (visible, not cleared); an empty draft
  // (opened + exited) → leave the status untouched. Non-rehab tools → 'received'.
  const rbTotal = Number(payload && payload.total);
  const sowOpen = !!sowMismatch || !goldSow.ok;
  const toolStatus = sowOpen ? (isFinite(rbTotal) && rbTotal > 0 ? 'issue' : null) : 'received';
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, tool_state=COALESCE($3,tool_state), status=COALESCE($4,status), updated_at=now()
      WHERE id=$1`,
    [req.params.itemId, JSON.stringify(payload),
     payload && typeof payload.state === 'object' ? JSON.stringify(payload.state) : null, toolStatus]);
  // Populate the condition with a plain-language note about the match state, on
  // BOTH a mismatch and a match — visible to every party. '[auto]' notes are ours
  // to overwrite; a staff-typed note is never clobbered.
  if (it.rows[0].tool_key === 'rehab_budget') {
    const rbMoney = require('../lib/rehab-budget').money;
    const note = sowMismatch
      ? `[auto] Scope of Work (line items ${rbMoney(rbTotal)}) does not match the file's rehab budget ${rbMoney(sowMismatch.required)} — this condition stays open for all parties until the first-page construction budget AND the line items each total exactly ${rbMoney(sowMismatch.required)}.`
      : (!goldSow.ok
        ? `[auto] ${require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG}`
        : `[auto] Scope of Work totals ${rbMoney(rbTotal)} and matches the file's rehab budget — ready to clear.`);
    try { await db.query(`UPDATE checklist_items SET notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END, updated_at=now() WHERE id=$1`, [req.params.itemId, note]); } catch (_) {}
  }
  // The Scope of Work NEVER writes the file's rehab budget (owner-directed — the
  // budget is frozen and set on the application / registered product). Just
  // re-evaluate the file's rule conditions after the save.
  if (it.rows[0].tool_key === 'rehab_budget') {
    try { await conditionEngine.evaluateApplication(req.params.id, { reason: 'rehab_budget_saved' }); } catch (_) {}
  }
  const storedExports = await storeToolAttachments({
    req, appId: req.params.id, borrowerId: own.rows[0].borrower_id,
    itemId: req.params.itemId, toolKey: it.rows[0].tool_key, attachments: stripped.attachments,
  });
  // Let the assigned loan team know the borrower completed this task.
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, a.ys_loan_number, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
    const row = a.rows[0];
    if (row) {
      const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
      const label = it.rows[0].tool_key === 'rehab_budget' ? 'rehab budget / scope of work' : 'task';
      const extra = it.rows[0].tool_key === 'rehab_budget' && isFinite(Number(payload.total))
        ? ` — total $${Math.round(Number(payload.total)).toLocaleString('en-US')}` : '';
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppStaff(req.params.id, {   // #113: whole team (primary + assistants)
          type: 'tool_submitted', title: `${who} submitted their ${label}`,
          body: `${ctx ? ctx.label : (row.ys_loan_number || 'A file')}${extra}. Fresh exports are attached to the condition.`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: req.params.id, link: `/internal/app/${req.params.id}`, ctaLabel: 'Review the scope of work' });
    }
  } catch (_) { /* notification is best-effort */ }
  // Always 200 — the SOW saved (as a draft on a mismatch). `mismatch` tells the
  // tool to show a non-blocking notice and let the user exit; the condition stays
  // open until the totals match exactly.
  const sowNotice = sowMismatch || (!goldSow.ok ? { gold: true, message: require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG } : undefined);
  res.json({ ok: true, status: toolStatus || 'outstanding', mismatch: sowNotice, exports: storedExports });
});

// ---------------- TOOL STATE (Scope of Work autosave) ----------------
// The static Scope of Work builder autosaves its full state onto the condition
// while the borrower works — reopening the tool restores exactly where they
// left off. Submitting (POST …/tool above) snapshots the state + exports.
router.get('/applications/:id/checklist/:itemId/tool-state', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT tool_state, tool_payload, status FROM checklist_items
      WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key IS NOT NULL`,
    [req.params.itemId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  const row = r.rows[0];
  const state = row.tool_state || (row.tool_payload && row.tool_payload.state) || null;
  res.json({ state, status: row.status, submitted: !!row.tool_payload });
});
router.put('/applications/:id/checklist/:itemId/tool-state', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const state = (req.body && typeof req.body.state === 'object') ? req.body.state : null;
  if (!state) return res.status(400).json({ error: 'state required' });
  const r = await db.query(
    `UPDATE checklist_items SET tool_state=$3, updated_at=now()
      WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key IS NOT NULL
      RETURNING id`,
    [req.params.itemId, req.params.id, JSON.stringify(state)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

// ---------------- LLCs + documents ----------------
// The LLC on the profile is the single source of truth: entity details,
// ownership structure (members), and the three document slots. Every list /
// detail response is the same "bundle" shape from src/lib/llc.js.
router.get('/llcs', async (req, res) => {
  const r = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 ORDER BY created_at`, [me(req)]);
  const out = [];
  for (const row of r.rows) out.push(scrubLlcSlots(await llcLib.getLlcBundle(row.id)));
  res.json(out.filter(Boolean));
});
router.get('/llcs/:id', async (req, res) => {
  // Own LLCs are fully accessible. A CO-BORROWER on a file vesting in this
  // LLC gets READ access (read_only:true) so the file's LLC condition renders
  // for them too — managing the entity stays with the borrower who owns it.
  const own = await db.query(`SELECT borrower_id FROM llcs WHERE id=$1`, [req.params.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const mine = own.rows[0].borrower_id === me(req);
  if (!mine) {
    const linked = await db.query(
      `SELECT 1 FROM applications WHERE llc_id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, me(req)]);
    if (!linked.rows[0]) {
      // Layered entities: the vesting LLC's OWNING entities render nested
      // inside its read-only view, so a co-borrower's read grant extends up
      // the ownership chain of any LLC vesting on their files.
      const vested = await db.query(
        `SELECT DISTINCT llc_id FROM applications
          WHERE llc_id IS NOT NULL AND (${OWN_FILE_SQL("", "$1")}) AND deleted_at IS NULL`, [me(req)]);
      let inChain = false;
      for (const row of vested.rows) {
        if ((await llcLib.getAncestorEntityIds(row.llc_id)).includes(String(req.params.id))) { inChain = true; break; }
      }
      if (!inChain) return res.status(404).json({ error: 'not found' });
    }
  }
  const bundle = scrubLlcSlots(await llcLib.getLlcBundle(req.params.id));
  res.json({ ...bundle, read_only: !mine });
});

// Entity-detail validators (member shape, ownership ceiling, EIN normalization)
// live in src/lib/llc.js so the borrower and staff write paths share one rulebook.
const { parseMembers, replaceMembers, normalizeEin } = llcLib;

router.post('/llcs', async (req, res) => {
  const b = req.body || {};
  if (!b.llcName) return res.status(400).json({ error: 'llcName required' });
  if (b.ownershipPct !== undefined && b.ownershipPct !== '' && b.ownershipPct != null) {
    const p = Number(b.ownershipPct);
    if (!isFinite(p) || p < 0 || p > 100) return res.status(400).json({ error: 'ownership % must be between 0 and 100' });
  }
  const ein = normalizeEin(b.ein);
  if (ein.error) return res.status(400).json({ error: ein.error });
  const parsed = parseMembers(b.members, b.ownershipPct);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // A name this borrower already has is REUSED, not duplicated or rejected —
  // creating "123 Main LLC" when it already exists just hands back the existing
  // entity so the picker/file links to it and inherits its docs + verification.
  const { id: llcId, existed } = await llcLib.findOrCreateLlc(me(req), {
    llcName: b.llcName, ein: ein.ein, formationState: b.formationState,
    formationDate: b.formationDate, ownershipPct: b.ownershipPct,
  });
  // Only a brand-new entity gets members + its document checklist; an existing
  // one keeps its own (never clobbered by a re-create).
  if (!existed) {
    if (parsed.members && parsed.members.length) {
      try { await replaceMembers(llcId, parsed.members, { borrowerId: me(req) }); }
      catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'could not save the members' }); }
    }
    // Requesting an LLC pulls its document requirements: EIN letter, formation docs, operating agreement.
    try { await generateLlcChecklist(llcId); } catch (_) {}
  }
  res.status(existed ? 200 : 201).json({ ok: true, llcId, existed });
});
// Fill in / correct an own entity's details (name / EIN / formation /
// ownership). A VERIFIED entity is locked — staff verified it as-is, so
// changing anything requires the loan team to revoke verification first.
router.patch('/llcs/:id', async (req, res) => {
  const own = await db.query(`SELECT is_verified FROM llcs WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — ask your loan team to unlock it before making changes' });
  const b = req.body || {};
  if (b.ein !== undefined) {
    const ein = normalizeEin(b.ein);
    if (ein.error) return res.status(400).json({ error: ein.error });
    b.ein = ein.ein === null ? '' : ein.ein;
  }
  const sets = [], vals = []; let i = 1;
  const map = { llcName: 'llc_name', ein: 'ein', formationState: 'formation_state', formationDate: 'formation_date', ownershipPct: 'ownership_pct' };
  // WO-6 (F-M11): a mid-typed formation date ('0026-07-15') must not persist as
  // year 26 — normalize it (2-digit year → 2026, garbage → null) like every
  // other typed date field, so the year-0026 class can't corrupt LLC ages.
  if (b.formationDate !== undefined) b.formationDate = require('../lib/fields').normalizeTypedDate(b.formationDate);
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
  if (b.llcName !== undefined && !String(b.llcName).trim()) return res.status(400).json({ error: 'llcName cannot be empty' });
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  // Raising the borrower's own stake must not push the total past 100%.
  if (b.ownershipPct !== undefined && b.ownershipPct !== '' && b.ownershipPct != null) {
    const mem = await db.query(`SELECT COALESCE(sum(ownership_pct),0) AS s FROM llc_members WHERE llc_id=$1`, [req.params.id]);
    const total = Number(b.ownershipPct) + Number(mem.rows[0].s);
    if (!isFinite(Number(b.ownershipPct)) || Number(b.ownershipPct) < 0 || Number(b.ownershipPct) > 100)
      return res.status(400).json({ error: 'ownership % must be between 0 and 100' });
    if (total > 100.01)
      return res.status(400).json({ error: `ownership exceeds 100% (${total.toFixed(2)}% with the other members) — adjust the members first` });
  }
  sets.push('updated_at=now()'); vals.push(req.params.id); vals.push(me(req));
  await db.query(`UPDATE llcs SET ${sets.join(',')} WHERE id=$${i++} AND borrower_id=$${i}`, vals);
  res.json({ ok: true });
});
// Replace the LLC's OTHER members (the borrower's own stake is ownership_pct
// on the LLC row). Shown whenever the borrower owns <100% — the section is
// complete when borrower % + member %s = 100.
router.put('/llcs/:id/members', async (req, res) => {
  const own = await db.query(`SELECT is_verified, ownership_pct FROM llcs WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — ask your loan team to unlock it before making changes' });
  const parsed = parseMembers((req.body || {}).members || [], own.rows[0].ownership_pct);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try { await replaceMembers(req.params.id, parsed.members || [], { borrowerId: me(req) }); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'could not save the members' }); }
  // Ownership feeds the entity condition (chain-aware) — recompute right away.
  try { await llcLib.syncLlcConditions(req.params.id); } catch (_) { /* best-effort */ }
  await audit(req, 'update_llc_members', 'llc', req.params.id, { count: (parsed.members || []).length });
  res.json({ ok: true });
});

// #110: the PRIMARY borrower can invite a co-borrower to an EXISTING file from
// the overview (not only at application time). Only the primary — not a
// co-borrower — may add one, and only when the file has no co-borrower yet.
router.post('/applications/:id/co-borrower', async (req, res) => {
  const b = req.body || {};
  const app = await db.query(
    `SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!app.rows[0] || app.rows[0].borrower_id !== me(req)) return res.status(404).json({ error: 'not found' });
  if (app.rows[0].co_borrower_id) return res.status(409).json({ error: 'This file already has a co-borrower.' });
  const email = String(b.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'a valid co-borrower email is required' });
  const primary = await db.query(`SELECT first_name,last_name,email FROM borrowers WHERE id=$1`, [me(req)]);
  // A borrower can't be their own co-borrower (would set co_borrower_id = borrower_id).
  if (String((primary.rows[0] || {}).email || '').toLowerCase() === email.toLowerCase())
    return res.status(400).json({ error: "You can't add yourself as your own co-borrower — use a different email." });
  const pn = primary.rows[0] ? `${primary.rows[0].first_name} ${primary.rows[0].last_name}`.trim() : '';
  try {
    const coId = await inviteCoBorrower(req.params.id, pn, { firstName: b.firstName, lastName: b.lastName, email, phone: b.phone, fico: b.fico });
    // Generate the co-borrower's own checklist/conditions on the file (same as the
    // application-time path), and remember the partner for reuse next time.
    try { await require('../lib/conditions/ensure').ensureFileConditions(req.params.id, { reason: 'co_borrower_added' }); } catch (_) {}
    try { await upsertPartner(me(req), { firstName: b.firstName, lastName: b.lastName, email, phone: b.phone, relationshipType: 'co_borrower' }); } catch (_) {}
    await audit(req, 'invite_co_borrower', 'application', req.params.id, { coBorrowerId: coId });
    res.status(201).json({ ok: true, coBorrowerId: coId });
  } catch (e) {
    // Lost the atomic slot race (audit F-LOW-1) — surface as the same 409 the
    // pre-check would have returned, not a 500.
    if (e && e.code === 'CO_BORROWER_EXISTS') return res.status(409).json({ error: 'This file already has a co-borrower.' });
    console.error('[co-borrower] invite failed:', db.describeError(e)); res.status(500).json({ error: 'could not invite the co-borrower' });
  }
});
router.get('/llcs/:id/documents', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(`SELECT id,filename,content_type,size_bytes,created_at FROM documents
     WHERE llc_id=$1 AND visibility='borrower' AND source_type <> 'chat_attachment' ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});
// Link (or switch) the vesting LLC on an open file. The file's LLC condition
// immediately reflects the linked entity's real state — a verified LLC
// auto-satisfies it; an unverified one turns it into "set up your LLC".
router.post('/applications/:id/link-llc', async (req, res) => {
  const b = req.body || {};
  if (!b.llcId) return res.status(400).json({ error: 'llcId required' });
  const app = await db.query(
    `SELECT id, llc_id, status, borrower_id FROM applications
      WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`,
    [req.params.id, me(req)]);
  if (!app.rows[0]) return res.status(404).json({ error: 'not found' });
  // S2-10: the vesting entity is the LLC taking title on the loan — a CO-borrower
  // must not be able to point it at THEIR own LLC. Only the primary borrower sets
  // vesting (and the LLC-ownership check below then scopes to the primary's library).
  if (String(app.rows[0].borrower_id) !== String(me(req)))
    return res.status(403).json({ error: 'Only the primary borrower can set the vesting entity for this loan.' });
  // The vesting entity is part of the loan structure — frozen at Clear-to-Close
  // and beyond (#84). Move the file back to an earlier status to change it.
  if (['clear_to_close', 'funded', 'declined', 'withdrawn'].includes(app.rows[0].status))
    return res.status(409).json({ error: 'This file is Clear to Close — the vesting entity is locked. Move it back to an earlier status to change it.' });
  const own = await db.query(`SELECT id FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'llc not found' });
  const previous = app.rows[0].llc_id;
  // Single authority (src/lib/vesting.js): set llc_id + full wiring (owner links,
  // LLC doc checklist, LLC condition recompute, rule re-eval) AND enqueue the
  // outbound ClickUp push so a borrower-set vesting entity propagates back to the
  // task — previously the vesting change was never pushed to ClickUp.
  try { await require('../lib/vesting').setVestingLlc(req.params.id, b.llcId, { source: 'borrower', force: true }); } catch (_) { /* best-effort */ }
  await audit(req, 'link_llc', 'application', req.params.id, { llcId: b.llcId, previous });
  res.json({ ok: true });
});

// ---------------- APPRAISAL PAYMENT CARD (a borrower condition) ----------------
// The borrower enters the card the appraisal is ordered on. Stored encrypted
// (AES-256-GCM, same key handling as SSNs); the back office decrypts it when
// placing the order. Luhn + expiry validated server-side.
// Card validation (Luhn/expiry/CVC) + at-rest save now live in the shared
// appraisal-card chokepoint (validateCardInput / saveApplicationCard, #107) so
// the borrower route AND the staff route behave identically.
// Tell the assigned LO + processor the appraisal card is on the file so they
// can place the order. Best-effort; carries only brand + last4 (never the PAN).
async function notifyAppraisalCardAdded(appId, brand, last4) {
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, a.ys_loan_number, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId]);
    const row = a.rows[0];
    if (!row) return;
    const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
    const ctxCard = await notify.fileContext(appId);
    await notify.notifyAppStaff(appId, {   // #113: whole team (primary + assistants)
        type: 'condition_added', title: `${who} added the appraisal card`,
        body: `${ctxCard ? ctxCard.label : (row.ys_loan_number || 'A file')} — ${brand} ending ${last4}. The appraisal can be ordered.`,
        meta: (ctxCard && ctxCard.meta) || undefined,
        applicationId: appId, link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file' });
  } catch (_) { /* best-effort */ }
}
router.post('/applications/:id/appraisal-card', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  // Validate + save through the shared chokepoint (#107) so the borrower route and
  // the staff route behave identically. The card OWNER is the file's borrower.
  const v = apprCard.validateCardInput(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  const saveForReuse = (req.body || {}).saveForReuse === true || (req.body || {}).saveForReuse === 'true';
  try {
    const { last4, brand } = await apprCard.saveApplicationCard({
      appId: req.params.id, borrowerId: me(req),
      number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear, zip: v.zip });
    // Opt-in: also persist an encrypted, reusable copy on the borrower's profile.
    // Best-effort — the per-file card is already saved, so a reuse-copy failure must
    // not 500 the primary action. Never log card data.
    let savedForReuse = false;
    if (saveForReuse) {
      try {
        await apprCard.saveCardForReuse(me(req), { number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear, zip: v.zip });
        savedForReuse = true;
      } catch (e) { console.error('[appraisal-card] save-for-reuse failed:', db.describeError(e)); }
    }
    await audit(req, 'save_appraisal_card', 'application', req.params.id, { last4, savedForReuse });
    await notifyAppraisalCardAdded(req.params.id, brand, last4);
    res.status(201).json({ ok: true, last4, brand, savedForReuse });
  } catch (e) { console.warn('[borrower] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});
// Masked view for the borrower's own condition row.
router.get('/applications/:id/appraisal-card', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT last4, brand, exp_month, exp_year, billing_zip, updated_at
       FROM application_payment_cards WHERE application_id=$1`, [req.params.id]);
  res.json(r.rows[0] || null);
});

// Scan a photo of the credit card via a hosted OCR API and return the parsed
// number + expiry for the borrower to confirm. The image is NOT persisted and
// card data is never logged. (Owner chose a hosted OCR API over on-device.)
router.post('/applications/:id/scan-card', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (!b.dataBase64) return res.status(400).json({ error: 'no image provided' });
  try {
    const parsed = await require('../lib/integrations/card-ocr').scanCard({ dataBase64: b.dataBase64, contentType: b.contentType });
    // Return only what we could read; the borrower confirms/edits before saving.
    res.json({ number: parsed.number || '', expMonth: parsed.expMonth || '', expYear: parsed.expYear || '' });
  } catch (e) {
    // Never surface raw provider errors (may echo request content) to the client.
    res.status(502).json({ error: 'Could not read the card from that photo — please enter the details below.' });
  }
});

// ---- Reuse the saved appraisal card on the next file ----
// Masked availability of the borrower's own reusable card (never decrypts the
// PAN). The portal calls this on an outstanding appraisal_card condition to
// offer a one-tap "use my saved card" instead of re-keying it.
router.get('/saved-appraisal-card', async (req, res) => {
  try {
    res.json(await apprCard.getSavedCard(me(req)));
  } catch (e) { console.warn('[borrower] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});
// Copy the borrower's saved card onto THIS application (a new file) and satisfy
// its appraisal_card condition — mirrors the direct-entry POST above. Only the
// borrower who owns the profile and is on this file can trigger it: the profile
// read is scoped to me(req) and the app must belong to me(req). (The shared
// copy logic lives in src/lib/appraisal-card.js so an authorized-staff route
// can reuse the exact same path.)
router.post('/applications/:id/appraisal-card/from-saved', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  try {
    const out = await apprCard.applySavedCardToApplication({
      applicationId: req.params.id, profileBorrowerId: me(req), actorId: me(req),
    });
    if (!out.ok) return res.status(400).json({ error: out.error });
    await audit(req, 'save_appraisal_card', 'application', req.params.id, { last4: out.last4, reused: true });
    await notifyAppraisalCardAdded(req.params.id, out.brand, out.last4);
    res.status(201).json({ ok: true, last4: out.last4, brand: out.brand, reused: true });
  } catch (e) { console.warn('[borrower] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Borrower-side application completeness: fill a missing field inline from the
// completeness panel. Same whitelist as staff (SSN excluded — it has its own
// secure flow). Scoped to the borrower's own file.
const B_COMPLETE_APP = { program: 'text', loan_type: 'text', property_type: 'text',
  purchase_price: 'money', as_is_value: 'money', arv: 'money', rehab_budget: 'money' };
const B_COMPLETE_BORROWER = { cell_phone: 'text', date_of_birth: 'date', fico: 'int', citizenship: 'text' };
router.post('/applications/:id/complete-fields', async (req, res) => {
  const own = await db.query(
    `SELECT borrower_id FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`,
    [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const bid = own.rows[0].borrower_id;
  const b = req.body || {};
  try {
    // S5-03: once a product is registered, the borrower can no longer write the
    // deal economics straight onto the live record — each proposed change becomes
    // an approval-gated change request that the loan officer + processor rule on.
    // Personal fields (below) stay directly editable either way.
    const locked = await changeRequests.isBorrowerLocked(req.params.id);
    const requested = [];
    const appVals = [req.params.id], appSets = [], appKeys = [];
    for (const [k, t] of Object.entries(B_COMPLETE_APP)) {
      if (!(k in b) || b[k] === '' || b[k] == null) continue;
      let v = b[k];
      if (t === 'money') { const s = String(v).replace(/[^0-9.]/g, ''); if (s === '') continue; v = Number(s); if (!Number.isFinite(v)) continue; }
      if (locked) {
        try {
          const cr = await changeRequests.openRequest(req.params.id, k, b[k],
            { reason: b.reason || null, requesterKind: 'borrower', requesterId: me(req) });
          if (!cr.unchanged) requested.push(cr);
        } catch (_) { /* skip a bad field, keep going with the rest */ }
        continue;   // never a live write for a governed field on a locked file
      }
      if (k === 'loan_type') v = require('../lib/fields').sanitizeLoanType(v);   // #95: never a program
      appVals.push(v); appSets.push(`${k}=$${appVals.length}`); appKeys.push(k);
    }
    // Couple units to a live property_type change. The completeness panel doesn't
    // collect units, so a single-family type must still auto-fill "1 unit" and a
    // switch to a multi type must not keep a stale single "1" (mirrors the intake
    // form's unitsForType, server-side). Only on the live-write path — a locked
    // file's property_type change becomes a change request instead.
    if (appKeys.includes('property_type')) {
      const newPt = appVals[appKeys.indexOf('property_type') + 1];
      const curU = (await db.query(`SELECT units FROM applications WHERE id=$1`, [req.params.id])).rows[0];
      const prevUnits = curU ? curU.units : null;
      const nextUnits = require('../lib/units').unitsForPropertyType(newPt, prevUnits);
      if (nextUnits !== prevUnits) { appVals.push(nextUnits); appSets.push(`units=$${appVals.length}`); appKeys.push('units'); }
    }
    if (appSets.length) {
      appSets.push('updated_at=now()');
      await db.query(`UPDATE applications SET ${appSets.join(', ')} WHERE id=$1`, appVals);
      try { require('../clickup/enqueue').enqueueClickupPush(req.params.id, appKeys); } catch (_) {}
    }
    // Personal fields update the actor's OWN profile only — a co-borrower must
    // not overwrite the primary borrower's DOB / phone / FICO / citizenship
    // (their own values differ). App/deal fields above are file-level and either
    // party may fill them. Owner-directed 2026-07-20: once the file is LOCKED
    // (accepted), a personal edit is ALSO approval-gated — it becomes a change
    // request against the borrower's OWN row, not a live write.
    const brVals = [me(req)], brSets = [], brKeys = [];
    for (const [k, t] of Object.entries(B_COMPLETE_BORROWER)) {
      if (!(k in b) || b[k] === '' || b[k] == null) continue;
      if (locked) {
        try {
          const cr = await changeRequests.openRequest(req.params.id, k, b[k],
            { reason: b.reason || null, requesterKind: 'borrower', requesterId: me(req), targetBorrowerId: me(req) });
          if (!cr.unchanged) requested.push(cr);
        } catch (_) { /* skip a bad field, keep going with the rest */ }
        continue;   // never a live write for a personal field on a locked file
      }
      let v = b[k];
      if (t === 'int') { v = k === 'fico' ? require('../lib/fields').sanitizeFico(v) : parseInt(v, 10); if (v == null || !Number.isFinite(v)) continue; }  // #90: FICO 300–850
      if (t === 'date') {  // 2026-07-15 incident: strict calendar + year bounds;
        // a typed 2-digit year resolves to the real year (DOB → adult century).
        v = require('../lib/fields').sanitizeDob(v);
        if (v == null) continue;
      }
      brVals.push(v); brSets.push(`${k}=$${brVals.length}`); brKeys.push(k);
    }
    if (brSets.length) {
      brSets.push('updated_at=now()');
      await db.query(`UPDATE borrowers SET ${brSets.join(', ')} WHERE id=$1`, brVals);
      // AUDIT with the FIELD NAMES: the DOB backdating provenance check reads
      // the audit trail for a human 'date_of_birth' fingerprint — without this
      // row a borrower's own typed DOB was invisible to it, and the backdating
      // rule could have silently overridden a human entry (post-merge audit
      // #271, provenance hole #1).
      await audit(req, 'complete_fields', 'application', req.params.id,
        { borrower: brKeys, borrowerId: me(req) });
      // A DOB/phone/FICO added after submit reaches ClickUp immediately (scoped
      // push, PRIMARY borrower only — a co-borrower's own-profile values must
      // never overwrite the parent task's primary-borrower fields).
      if (me(req) === bid) { try { require('../clickup/enqueue').enqueueClickupPush(req.params.id, brKeys); } catch (_) {} }
    }
    // One team notice for ALL of this borrower's proposed changes (economics +
    // personal), each with its before → after, so the loan team can review together.
    if (requested.length) await notifyTeamOfChangeRequests(req.params.id, requested);
    res.json({
      ok: true,
      locked,
      // When the file is locked, tell the UI which economics edits were turned
      // into pending change requests (so it can show "sent to your loan team").
      changeRequests: requested.map((r) => ({ field: r.field, label: r.field_label, newValue: r.new_value })),
    });
  } catch (e) { console.warn('[borrower] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Tell the loan officer + processor a borrower has proposed an economics change
// on a registered file (S5-03). Best-effort; mirrors the info-condition notice.
async function notifyTeamOfChangeRequests(appId, requested) {
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId]);
    const row = a.rows[0]; if (!row) return;
    const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
    const fields = requested.map((r) => r.field_label).join(', ');
    // Before → after for each requested field, so the team sees exactly what is
    // being asked without opening the file.
    const changeLines = requested.map((r) => changeRequests.describeChange(r)).join('; ');
    const ctx = await notify.fileContext(appId);
    await notify.notifyAppStaff(appId, {   // #113: whole team (primary + assistants)
        type: 'change_request',
        title: `${who} requested a change to ${fields}`,
        body: `${ctx ? ctx.label : 'A file'} — ${changeLines}. Review and approve or reject it.`,
        meta: (ctx && ctx.meta) || undefined,
        applicationId: appId, link: `/internal/app/${appId}`, ctaLabel: 'Review the change' });
  } catch (_) { /* best-effort */ }
}

// The borrower's own change requests for a file (pending first). `locked` tells
// the UI whether the file is past registration (so it shows the sandbox instead
// of directly-editable economics fields). Decision notes are scrubbed like every
// other borrower-facing text so no capital-partner name can slip through.
router.get('/applications/:id/change-requests', async (req, res) => {
  const own = await db.query(
    `SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")}) AND deleted_at IS NULL`,
    [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  // Economics requests are file-level (either borrower may see them); PERSONAL
  // (borrowers-entity) requests are per-borrower — a co-borrower must not see the
  // primary's identity change (its masked SSN / DOB), so scope those to the viewer.
  const r = await db.query(
    `SELECT id, field, field_label, old_value, new_value, reason, status, decision_note, created_at, decided_at
       FROM change_requests
      WHERE application_id=$1 AND (target_table='applications' OR target_id=$2)
      ORDER BY (status='pending') DESC, created_at DESC LIMIT 50`, [req.params.id, me(req)]);
  res.json({
    locked: await changeRequests.isBorrowerLocked(req.params.id),
    requests: r.rows.map((row) => ({ ...row, decision_note: scrubText(row.decision_note) })),
  });
});

// ---------------- SERVICE CONTACTS (title company / insurance agent) ----------------
// Reusable across files: the borrower enters a contact once and links it on
// future files via autocomplete. tool_key on the checklist item decides which
// contact type the form collects.
const CONTACT_TYPES = ['title_company', 'insurance_agent', 'attorney', 'contractor', 'other'];
router.get('/contacts', async (req, res) => {
  const type = CONTACT_TYPES.includes(req.query.type) ? req.query.type : null;
  // merged_into_id is set when an admin merged this contact into another
  // vendor (db/224). Hide it from the borrower's autocomplete so they never
  // pick a soft-deleted duplicate — the survivor already carries the data.
  const r = await db.query(
    `SELECT id,contact_type,company_name,contact_name,email,phone,last_used_at
       FROM service_contacts
      WHERE borrower_id=$1 AND merged_into_id IS NULL
        AND ($2::text IS NULL OR contact_type=$2)
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
    const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [b.applicationId, me(req)]);
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
    // S2-09: borrower-facing items only — the id is borrower-supplied, so file
    // ownership alone can't stop a borrower flipping a staff-only condition.
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE id=$1 AND audience IN ('borrower','both')
          AND application_id IN (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$2")})`,
      [b.checklistItemId, me(req)]);
    enqueueChecklistStatusPush(b.checklistItemId).catch(() => {}); // mapped conditions → ClickUp dropdown
  }
  await audit(req, 'save_contact', 'borrower', me(req), { contactType: type, applicationId: b.applicationId || null });
  res.status(201).json({ ok: true, contactId });
});

// ---------------- GENERAL FILE CONTACTS (#144) ----------------
// Any party can add any kind of vendor to a file; contacts live in
// service_contacts (=> company-wide vendor management) and link to the file via
// application_service_contacts (MANY per file). Shared across the file.
const FILE_CONTACT_TYPES = ['realtor', 'attorney', 'title_company', 'insurance_agent', 'flood_insurance', 'contractor', 'appraiser', 'lender', 'escrow', 'other'];
router.get('/applications/:id/file-contacts', async (req, res) => {
  const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!o.rows[0]) return res.status(404).json({ error: 'application not found' });
  const r = await db.query(
    `SELECT l.id AS link_id, sc.id AS contact_id, sc.contact_type, sc.custom_type,
            sc.company_name, sc.contact_name, sc.email, sc.phone, sc.address, sc.notes,
            l.added_by_kind, l.created_at
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
      WHERE l.application_id=$1
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [req.params.id]);
  res.json(r.rows);
});
router.post('/applications/:id/file-contacts', async (req, res) => {
  const b = req.body || {};
  const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!o.rows[0]) return res.status(404).json({ error: 'application not found' });
  const type = FILE_CONTACT_TYPES.includes(b.contactType) ? b.contactType : 'other';
  const custom = type === 'other' ? (String(b.customType || '').trim().slice(0, 60) || null) : null;
  if (!b.companyName && !b.contactName && !b.email && !b.phone) return res.status(400).json({ error: 'enter at least one contact detail' });
  const sc = await db.query(
    `INSERT INTO service_contacts (borrower_id,contact_type,custom_type,company_name,contact_name,email,phone,address,notes,added_by_borrower_id,last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$1,now()) RETURNING id`,
    [me(req), type, custom, b.companyName || null, b.contactName || null, b.email || null, b.phone || null, b.address || null, b.notes || null]);
  const scId = sc.rows[0].id;
  const link = await db.query(
    `INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type,added_by_kind,added_by_id)
     VALUES ($1,$2,$3,'borrower',$4)
     ON CONFLICT (application_id,service_contact_id) DO UPDATE SET contact_type=EXCLUDED.contact_type RETURNING id`,
    [req.params.id, scId, type, me(req)]);
  await audit(req, 'add_file_contact', 'application', req.params.id, { contactType: type });
  res.status(201).json({ ok: true, linkId: link.rows[0].id, contactId: scId });
});
// Edit a file contact in place (owner-directed 2026-07-16 — parity with staff).
router.patch('/file-contacts/:linkId', async (req, res) => {
  const b = req.body || {};
  if (!b.companyName && !b.contactName && !b.email && !b.phone) return res.status(400).json({ error: 'enter at least one contact detail' });
  // Own-file guard: resolve the link to its service_contact only for files the
  // borrower owns.
  const link = await db.query(
    `SELECT l.service_contact_id FROM application_service_contacts l JOIN applications a ON a.id=l.application_id
      WHERE l.id=$1 AND a.deleted_at IS NULL AND (${OWN_FILE_SQL("a", "$2")})`, [req.params.linkId, me(req)]);
  if (!link.rows[0]) return res.status(404).json({ error: 'not found' });
  const type = FILE_CONTACT_TYPES.includes(b.contactType) ? b.contactType : null;
  const custom = type === 'other' ? (String(b.customType || '').trim().slice(0, 60) || null) : null;
  await db.query(
    `UPDATE service_contacts SET contact_type=COALESCE($2, contact_type),
        custom_type=CASE WHEN $2::text IS NULL THEN custom_type ELSE $3 END,
        company_name=$4, contact_name=$5, email=$6, phone=$7, address=$8, notes=$9, updated_at=now()
      WHERE id=$1`,
    [link.rows[0].service_contact_id, type, custom, b.companyName || null, b.contactName || null,
     b.email || null, b.phone || null, b.address || null, b.notes || null]);
  if (type) await db.query(`UPDATE application_service_contacts SET contact_type=$2 WHERE id=$1`, [req.params.linkId, type]);
  res.json({ ok: true });
});
router.delete('/file-contacts/:linkId', async (req, res) => {
  const r = await db.query(
    `DELETE FROM application_service_contacts l USING applications a
      WHERE l.id=$1 AND l.application_id=a.id AND (${OWN_FILE_SQL("a", "$2")}) RETURNING l.id`,
    [req.params.linkId, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
// Borrower profile: every vendor this borrower is dealing with, across all files.
// Hides merged rows (db/224) so a soft-deleted duplicate never shows as its own entry.
router.get('/my-contacts', async (req, res) => {
  const r = await db.query(
    `SELECT sc.id, sc.contact_type, sc.custom_type, sc.company_name, sc.contact_name, sc.email, sc.phone, sc.notes,
            count(l.application_id)::int AS files_used
       FROM service_contacts sc
       LEFT JOIN application_service_contacts l ON l.service_contact_id = sc.id
      WHERE sc.borrower_id=$1 AND sc.merged_into_id IS NULL
      GROUP BY sc.id
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [me(req)]);
  res.json(r.rows);
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

// ---------------- TRACK RECORDS (general per-borrower section) ----------------
// A borrower's track record is one general dataset — never tied to a single
// file. Loan-file experience conditions link here automatically.
router.get('/track-records', async (req, res) => {
  // Explicit borrower-safe allowlist — NEVER `t.*`. The row carries internal-only
  // columns the borrower must not see: `lo_notes` (candid staff notes on the deal,
  // S2-06), `verified_by` (which staffer verified it, S2-11), plus the internal
  // verification_status and ClickUp sync fields. `notes` is the BORROWER'S OWN
  // field ("anything the underwriter should know") and is kept. Send only the
  // borrower's own factual deal data + the plain "verified" boolean and doc status.
  const r = await db.query(
    `SELECT t.id, t.borrower_id, t.llc_id, t.property_address, t.deal_type,
            t.purchase_price, t.sale_price, t.rehab_amount, t.purchase_date, t.sale_date,
            t.rent_amount, t.rent_date, t.refi_amount, t.refi_date, t.current_value, t.notes,
            t.is_verified, t.docs_status, t.owned_personally, t.created_at, t.updated_at,
            COALESCE(t.entity_name, l.llc_name) AS entity_name,
            (SELECT count(*)::int FROM documents d WHERE d.track_record_id=t.id) AS doc_count,
            (SELECT COALESCE(json_agg(json_build_object(
                    'id', d.id, 'filename', d.filename, 'review_status', d.review_status,
                    'created_at', d.created_at) ORDER BY d.created_at), '[]'::json)
               FROM documents d
              WHERE d.track_record_id=t.id AND d.visibility='borrower' AND d.is_current) AS docs,
            (SELECT COALESCE(json_agg(json_build_object(
                    'id', ci.id, 'label', COALESCE(ci.borrower_label, ci.label),
                    'hint', COALESCE(ci.borrower_hint, ci.hint), 'status', ci.status) ORDER BY ci.created_at), '[]'::json)
               FROM checklist_items ci
              WHERE ci.track_record_id=t.id AND ci.audience IN ('borrower','both')
                AND ci.status NOT IN ('satisfied')) AS doc_requests
       FROM track_records t
       LEFT JOIN llcs l ON l.id = t.llc_id
      WHERE t.borrower_id=$1 ORDER BY t.sale_date DESC NULLS LAST, t.created_at DESC`, [me(req)]);
  res.json(r.rows);
});
// Shared field validation + column mapping for create/update. Mirrors the
// static Track Record tool's rules: a flip needs a sale; a hold needs a
// lease-up or refinance exit; ground-up needs any exit.
// The ONLY hard requirement to SAVE a track-record line is a property address —
// the line's identity (owner-directed 2026-07-12: "each required field should be
// able to be completed and saved independently… it should still save even if you
// don't have all the information"). Every other field is optional and persisted
// as-provided so a borrower/officer can fill the record incrementally / autosave.
// Completeness is surfaced as a NON-BLOCKING warning (trackRecordMissing) and
// separately governs whether the entry QUALIFIES toward experience (verified +
// recent exit, in track-record.js qualifies()) — an incomplete row saves fine, it
// just doesn't count yet. `trackRecordErrors` keeps its name (imported elsewhere)
// but is now the minimal save gate.
function trackRecordErrors(b) {
  const addressText = b.propertyAddress && (b.propertyAddress.oneLine || b.propertyAddress.street || b.propertyAddress.line1);
  if (!addressText) return 'property address is required';
  return null;
}
// What this entry still needs to be COMPLETE (count toward experience). Returned
// to the UI as a warning list so it can show "still needed: …" at the bottom of
// the line. NEVER blocks the save.
function trackRecordMissing(b) {
  const typeText = String(b.dealType || 'flip').toLowerCase();
  const isHold = typeText.indexOf('hold') >= 0 || typeText.indexOf('rental') >= 0;
  const isGround = typeText.indexOf('ground') >= 0;
  const miss = [];
  if (!moneyField(b.purchasePrice)) miss.push('purchase price');
  if (!b.purchaseDate) miss.push('purchase date');
  if (!moneyField(b.rehabAmount)) miss.push('rehab budget');
  if (!isHold && !isGround) {
    if (!moneyField(b.salePrice)) miss.push('sale price');
    if (!b.saleDate) miss.push('sale date');
  }
  if (isHold) {
    if (!moneyField(b.rentAmount) && !moneyField(b.refiAmount)) miss.push('monthly rent or refinance amount');
    if (!b.rentDate && !b.refiDate) miss.push('rent date or refinance date');
  }
  if (isGround && !((moneyField(b.salePrice) && b.saleDate) || (moneyField(b.rentAmount) && b.rentDate) || (moneyField(b.refiAmount) && b.refiDate))) {
    miss.push('a completed exit (sale, rent, or refinance)');
  }
  return miss;
}
function trackRecordCols(b) {
  // "Owned under my personal name" excludes an entity: the flag wins over any
  // stale entityName/llcId still sitting in the payload (the tool clears them,
  // but the server enforces it so no write path can save both).
  const personal = !!b.ownedPersonally;
  return {
    owned_personally: personal,
    property_address: JSON.stringify(b.propertyAddress),
    deal_type: b.dealType || 'flip',
    purchase_price: moneyField(b.purchasePrice),
    sale_price: moneyField(b.salePrice),
    rehab_amount: moneyField(b.rehabAmount),
    // Exit/entry dates feed the experience-window math — a 2-digit-year date
    // must never persist (2026-07-15 audit #5). sanitizeDateOnly: real calendar
    // date, year 1900–2100, else null.
    purchase_date: require('../lib/fields').normalizeTypedDate(b.purchaseDate),
    sale_date: require('../lib/fields').normalizeTypedDate(b.saleDate),
    rent_amount: moneyField(b.rentAmount),
    rent_date: require('../lib/fields').normalizeTypedDate(b.rentDate),
    refi_amount: moneyField(b.refiAmount),
    refi_date: require('../lib/fields').normalizeTypedDate(b.refiDate),
    current_value: moneyField(b.currentValue),
    notes: b.notes ? String(b.notes).slice(0, 1000) : null,
    property_type: b.propertyType ? String(b.propertyType).slice(0, 60) : null,
    entity_name: (!personal && b.entityName) ? String(b.entityName).slice(0, 160) : null,
  };
}
router.post('/track-records', async (req, res) => {
  const b = req.body || {};
  if (b.ownedPersonally) b.llcId = null;   // personal-name line carries no entity
  // An LLC reference must be one of the borrower's own entities.
  if (b.llcId) {
    const own = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!own.rows[0]) return res.status(404).json({ error: 'llc not found' });
  }
  const bad = trackRecordErrors(b);
  if (bad) return res.status(400).json({ error: bad });
  const cols = trackRecordCols(b);
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  // Idempotent create: the tool sends one stable clientRowId per new line, so a
  // repeated POST (autosave retry, second tab, network replay) UPDATEs the one
  // row instead of inserting a duplicate. A verified row is locked (mirrors the
  // PUT guard) — the conflict then no-ops and we re-select its id. Rows without
  // a clientRowId keep plain-insert behavior (the partial index ignores NULLs).
  const clientRowId = b.clientRowId ? String(b.clientRowId).slice(0, 80) : null;
  const allNames = ['borrower_id', 'llc_id', 'client_row_id', ...names];
  const allVals = [me(req), b.llcId || null, clientRowId, ...vals];
  const ph = allVals.map((_, i) => '$' + (i + 1)).join(',');
  const updateSet = ['llc_id=EXCLUDED.llc_id', ...names.map(n => `${n}=EXCLUDED.${n}`), 'updated_at=now()'].join(', ');
  const r = await db.query(
    `INSERT INTO track_records (${allNames.join(',')}) VALUES (${ph})
     ON CONFLICT (borrower_id, client_row_id) WHERE client_row_id IS NOT NULL
       DO UPDATE SET ${updateSet} WHERE track_records.is_verified = false
     RETURNING id`,
    allVals);
  // Conflict hit a verified (locked) row → no row returned; hand back its id.
  let trId = r.rows[0] && r.rows[0].id;
  if (!trId && clientRowId) {
    const ex = await db.query(`SELECT id FROM track_records WHERE borrower_id=$1 AND client_row_id=$2`, [me(req), clientRowId]);
    trId = ex.rows[0] && ex.rows[0].id;
  }
  try { await syncExperienceChecklistForBorrower(me(req)); } catch (_) { /* best-effort */ }
  // Live cross-user refresh (#112): staff viewing this borrower's record reload.
  require('../lib/events').publishTrackRecordUpdate(me(req), { kind: 'borrower', id: me(req) }).catch(() => {});
  res.status(201).json({ ok: true, trackRecordId: trId, missing: trackRecordMissing(b) });
});
// Edit an entry — only the borrower's own, and only while it is unverified
// (a verified entry is locked as underwriting evidence).
router.put('/track-records/:id', async (req, res) => {
  const b = req.body || {};
  if (b.ownedPersonally) b.llcId = null;   // personal-name line carries no entity
  const own = await db.query(`SELECT 1 FROM track_records WHERE id=$1 AND borrower_id=$2 AND is_verified=false`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found or already verified' });
  if (b.llcId) {
    const l = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!l.rows[0]) return res.status(404).json({ error: 'llc not found' });
  }
  const bad = trackRecordErrors(b);
  if (bad) return res.status(400).json({ error: bad });
  const cols = trackRecordCols(b);
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  await db.query(
    `UPDATE track_records SET llc_id=$3, ${names.map((n, i) => `${n}=$${i + 4}`).join(', ')}, updated_at=now()
      WHERE id=$1 AND borrower_id=$2`,
    [req.params.id, me(req), b.llcId || null, ...vals]);
  try { await syncExperienceChecklistForBorrower(me(req)); } catch (_) { /* best-effort */ }
  require('../lib/events').publishTrackRecordUpdate(me(req), { kind: 'borrower', id: me(req) }).catch(() => {});
  res.json({ ok: true, missing: trackRecordMissing(b) });
});
// Delete a track-record entry — only the borrower's own, and only while it is
// still unverified (a verified entry is locked as underwriting evidence).
router.delete('/track-records/:id', async (req, res) => {
  const r = await db.query(
    `DELETE FROM track_records WHERE id=$1 AND borrower_id=$2 AND is_verified=false RETURNING id`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found or already verified' });
  try { await syncExperienceChecklistForBorrower(me(req)); } catch (_) { /* best-effort */ }
  require('../lib/events').publishTrackRecordUpdate(me(req), { kind: 'borrower', id: me(req) }).catch(() => {});
  res.json({ ok: true });
});
// Supporting documents on ONE track-record entry (closing statement, deed,
// lease…) — what staff verify against.
// #112: the optional document TYPE a track-record supporting doc can be tagged with
// (stored in documents.slot_label). Kept in sync with the tool's dropdown in
// web/tools/track-record-portal.js. `trackDocType(v)` returns a valid label or null.
const TRACK_RECORD_DOC_TYPES = [
  'Closing statement (HUD)', 'Deed', 'Recorded mortgage', 'Payoff statement',
  'Lease', 'Property profile report', 'Other',
];
const TRACK_RECORD_DOC_TYPE_SET = new Set(TRACK_RECORD_DOC_TYPES);
const trackDocType = (v) => (TRACK_RECORD_DOC_TYPE_SET.has(String(v || '').trim()) ? String(v).trim() : null);

router.get('/track-records/:id/documents', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM track_records WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,created_at,review_status,rejection_reason,slot_label AS doc_type FROM documents
      WHERE track_record_id=$1 AND visibility='borrower' AND is_current ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});
router.post('/track-records/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  const own = await db.query(`SELECT 1 FROM track_records WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
  try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  // A back-office document request for THIS line item (a condition tagged with
  // track_record_id) is satisfied by uploading straight to the line: attach the
  // document to the oldest open request so it counts as the condition's doc too.
  const openReq = await db.query(
    `SELECT id FROM checklist_items
      WHERE track_record_id=$1 AND item_kind='document' AND audience IN ('borrower','both')
        AND status IN ('outstanding','requested','issue')
      ORDER BY created_at LIMIT 1`, [req.params.id]);
  const reqItemId = openReq.rows[0] ? openReq.rows[0].id : null;
  const dupTr = await require('../lib/doc-dedup').recentDuplicateDocId({   // idempotency (#87)
    filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'borrower', uploadedById: me(req),
    trackRecordId: req.params.id, checklistItemId: reqItemId, docKind: 'track_record_doc' });
  if (dupTr) return res.status(201).json({ ok: true, documentId: dupTr, deduped: true });
  const r = await db.query(
    `INSERT INTO documents (borrower_id,track_record_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'borrower',$1,'track_record_doc',$9) RETURNING id`,
    [me(req), req.params.id, reqItemId, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, trackDocType(b.docType)]);
  await db.query(`UPDATE track_records SET docs_status='received', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [req.params.id]);
  if (reqItemId) {
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE id=$1 AND status IN ('outstanding','requested','issue')`, [reqItemId]);
    enqueueChecklistStatusPush(reqItemId).catch(() => {});
  }
  await audit(req, 'upload_track_record_doc', 'track_record', req.params.id, { filename: b.filename });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  // Live cross-user refresh (#112): staff viewing this record see the new doc.
  require('../lib/events').publishTrackRecordUpdate(me(req), { kind: 'borrower', id: me(req) }).catch(() => {});
  res.status(201).json({ ok: true, documentId: r.rows[0].id });

  // The upload answered an open back-office request — tell the file's loan
  // team it's ready for review (best-effort, after the response).
  if (reqItemId) {
    try {
      const it = await db.query(
        `SELECT ci.label, ci.application_id, a.loan_officer_id, a.processor_id
           FROM checklist_items ci LEFT JOIN applications a ON a.id=ci.application_id
          WHERE ci.id=$1`, [reqItemId]);
      const row = it.rows[0];
      if (row) {
        if (row.application_id) await notify.notifyAppStaff(row.application_id, {   // #113: whole team
          type: 'doc_uploaded', title: 'Requested track-record document uploaded',
          body: `"${b.filename}" was uploaded for "${row.label}".`,
          applicationId: row.application_id,
          link: `/internal/app/${row.application_id}`,
          ctaLabel: 'Review the document',
        });
      }
    } catch (_) { /* never fail the upload on a notify hiccup */ }
  }
});

// The saved STATIC COPY of the track record: the live builder posts a fresh
// self-contained HTML file after every change; one current copy per borrower,
// downloadable from the Profile section and every file's experience condition.
router.put('/track-record/snapshot', async (req, res) => {
  const b = req.body || {};
  try {
    const out = await require('../lib/track-record-snapshot').saveSnapshot(me(req), {
      html: b.html, filename: b.filename, uploadedByKind: 'borrower', uploadedById: me(req),
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[borrower] snapshot error:', db.describeError(e));
    res.status(500).json({ error: 'could not save the snapshot' });
  }
});
router.get('/track-record/snapshot', async (req, res) => {
  try { res.json(await require('../lib/track-record-snapshot').latestSnapshot(me(req))); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- DOCUMENTS (upload metadata + bytes via storage) ----------------
// Accepts base64 body {filename, contentType, dataBase64, applicationId|llcId, checklistItemId}
router.post('/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  // ownership check for whichever owner is supplied
  if (b.applicationId) {
    const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [b.applicationId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'application not found' });
  }
  if (b.llcId) {
    const o = await db.query(`SELECT is_verified, llc_name FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'llc not found' });
    // A verified LLC's document set is locked — staff verified it as-is.
    if (o.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — ask your loan team to unlock it before replacing documents' });
  }
  // Term sheets auto-attach to the Products & Pricing register condition as a
  // document slot (owner-directed #139): the registered term sheet saves straight
  // into that condition, not just as a loose file — unless the caller already
  // targeted a specific condition or an LLC slot.
  if (b.docKind === 'term_sheet' && b.applicationId && !b.checklistItemId && !b.llcId) {
    const pp = await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' ORDER BY created_at LIMIT 1`,
      [b.applicationId]);
    if (pp.rows[0]) { b.checklistItemId = pp.rows[0].id; if (!b.slot) b.slot = 'Term sheet'; }
  }
  // The checklist item must be the borrower's own too — otherwise the document
  // row can be pointed at another borrower's checklist-item id.
  let trackRecordId = null;   // inherited from a line-item request condition
  if (b.checklistItemId) {
    const o = await db.query(
      `SELECT ci.llc_id, ci.track_record_id FROM checklist_items ci
        WHERE ci.id=$1 AND (ci.borrower_id=$2
           OR ci.application_id IN (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$2")})
           OR ci.llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`,
      [b.checklistItemId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'checklist item not found' });
    // A condition raised FOR one track-record line item: the upload belongs to
    // that line too, so it lands on the line item and in its REO/<address>
    // folder — not only on the condition.
    trackRecordId = o.rows[0].track_record_id || null;
    // An llc-scoped item's uploads ALWAYS belong to that LLC, even when the
    // caller omits llcId — otherwise the verified-lock (and the document's
    // llc_id linkage) could be sidestepped by posting the bare item id.
    if (o.rows[0].llc_id) {
      if (b.llcId && b.llcId !== o.rows[0].llc_id) return res.status(400).json({ error: 'llcId does not match the checklist item' });
      b.llcId = o.rows[0].llc_id;
      const v = await db.query(`SELECT is_verified FROM llcs WHERE id=$1`, [b.llcId]);
      if (v.rows[0] && v.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — ask your loan team to unlock it before replacing documents' });
    }
  }
  let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
  try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  // Optional kind tag. 'term_sheet' marks the registered-product term sheet
  // PDF captured from the Term Sheet Studio: each re-registration supersedes
  // the previous term sheet so exactly one is current on the file.
  const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;
  // Optional slot: a condition holds several coexisting documents, each in its
  // own named slot. Re-uploading a slot supersedes only that slot's versions.
  const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  // Idempotency (#87): a double-submitted upload (React double-invoke, a drop
  // firing twice, a client retry) must not create a second document row + a
  // second "New document uploaded" email. Collapse a byte-identical re-upload to
  // the same context within the window onto the already-saved document.
  const dupId = await require('../lib/doc-dedup').recentDuplicateDocId({
    filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'borrower', uploadedById: me(req),
    applicationId: b.applicationId || null, checklistItemId: b.checklistItemId || null,
    llcId: b.llcId || null, trackRecordId, slotLabel: slot, docKind });
  if (dupId) return res.status(201).json({ ok: true, documentId: dupId, deduped: true });
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (checklist_item_id,application_id,borrower_id,llc_id,track_record_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'borrower',$11,$12,$13) RETURNING id`,
    [b.checklistItemId || null, b.applicationId || null, me(req), b.llcId || null, trackRecordId,
     b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, me(req), docKind, slot]);
  // The requested line item has its document — reflect it on the line too.
  if (trackRecordId) {
    await db.query(
      `UPDATE track_records SET docs_status='received', updated_at=now()
        WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [trackRecordId]);
  }
  if (docKind === 'term_sheet' && b.applicationId) {
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND doc_kind='term_sheet' AND id<>$2 AND is_current=true`,
      [b.applicationId, r.rows[0].id]);
  }
  if (b.checklistItemId) {
    // A re-upload supersedes the borrower's prior versions so a rejected/old
    // document never stays part of the file. With a slot (or an explicit
    // replaceDocumentId), only THAT slot's versions are superseded — the
    // condition's other documents coexist. Documents dropped STRAIGHT on a
    // track-record card (doc_kind='track_record_doc') attach to the same
    // request condition but are line-item evidence — a condition-row upload
    // must never supersede them off the card.
    if (b.replaceDocumentId) {
      await db.query(
        `UPDATE documents SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE id=$1 AND checklist_item_id=$2 AND borrower_id=$3`,
        [b.replaceDocumentId, b.checklistItemId, me(req)]);
    }
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE checklist_item_id=$1 AND borrower_id=$2 AND id<>$3 AND is_current=true
          AND COALESCE(doc_kind,'') <> 'track_record_doc'
          AND ($4::text IS NOT NULL OR $5::uuid IS NULL)
          AND ($4::text IS NULL OR slot_label IS NOT DISTINCT FROM $4)`,
      [b.checklistItemId, me(req), r.rows[0].id, slot, b.replaceDocumentId || null]);
    // S2-09: only a BORROWER-FACING item may be flipped by a borrower — never a
    // staff-only condition (the id is borrower-supplied, so ownership alone is not
    // enough). Mirrors the audience guard on the tool/info endpoints.
    // A new version is unreviewed evidence — clear any prior sign-off so the
    // swapped-in file is re-reviewed (it must not ride a stale sign-off to
    // clear-to-close). The audience + ownership guard is unchanged.
    await db.query(`UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now() WHERE id=$1 AND audience IN ('borrower','both') AND (application_id IN (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$2")}) OR borrower_id=$2 OR llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`, [b.checklistItemId, me(req)]);
    enqueueChecklistStatusPush(b.checklistItemId).catch(() => {}); // mapped conditions → ClickUp dropdown
  }
  // An LLC document changed — recompute the LLC condition on every open file
  // vesting in this entity (all three in => the condition moves to review).
  if (b.llcId) { try { await llcLib.syncLlcConditions(b.llcId); } catch (_) { /* best-effort */ } }
  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  // Live cross-user refresh (#112): a doc answering a track-record line-item
  // request lands on the line — staff viewing it reload to see the new evidence.
  if (trackRecordId) require('../lib/events').publishTrackRecordUpdate(me(req), { kind: 'borrower', id: me(req) }).catch(() => {});
  res.status(201).json({ ok: true, documentId: r.rows[0].id });

  // An LLC document uploaded from the profile (no file context): tell the loan
  // teams of every open file vesting in this LLC — or the borrower's primary
  // officer when no file is linked yet (best-effort, after the response).
  if (b.llcId && !b.applicationId) {
    try {
      const info = await db.query(
        `SELECT l.llc_name, b.first_name, b.last_name, b.primary_officer_id
           FROM llcs l JOIN borrowers b ON b.id=l.borrower_id WHERE l.id=$1`, [b.llcId]);
      const row = info.rows[0];
      if (row) {
        const who = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A borrower';
        const apps = await db.query(
          `SELECT id FROM applications
            WHERE llc_id=$1 AND deleted_at IS NULL
              AND status NOT IN ('funded','declined','withdrawn')`, [b.llcId]);
        // #113: notify the WHOLE team (primary + assistants) across every active
        // application that uses this LLC, de-duplicated.
        const tRows = await db.query(
          `SELECT DISTINCT aa.staff_id FROM application_assignees aa
             JOIN applications a ON a.id=aa.application_id
            WHERE a.llc_id=$1 AND a.deleted_at IS NULL
              AND a.status NOT IN ('funded','declined','withdrawn')
              AND aa.removed_at IS NULL AND aa.staff_id IS NOT NULL`, [b.llcId]);
        const targets = new Set(tRows.rows.map((r) => r.staff_id));
        if (!targets.size && row.primary_officer_id) targets.add(row.primary_officer_id);
        let slotLabel = '';
        if (b.checklistItemId) {
          const it = await db.query(`SELECT label FROM checklist_items WHERE id=$1`, [b.checklistItemId]);
          if (it.rows[0]) slotLabel = ` — ${it.rows[0].label}`;
        }
        for (const sid of targets) {
          await notify.notifyStaff(sid, {
            type: 'doc_uploaded', title: 'New LLC document uploaded',
            body: `${who} uploaded "${b.filename}" to LLC "${row.llc_name}"${slotLabel}.`,
            applicationId: apps.rows[0] ? apps.rows[0].id : null,
            link: apps.rows[0] ? `/internal/app/${apps.rows[0].id}` : '/internal',
            ctaLabel: 'Review the document',
          });
        }
      }
    } catch (_) { /* never fail the upload on a notify hiccup */ }
  }

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
        // Say WHERE the document landed, not just its filename: the condition
        // it was uploaded to and, when the condition has several slots, which.
        let where = '', condLabel = '';
        if (b.checklistItemId) {
          const it = await db.query(`SELECT label FROM checklist_items WHERE id=$1`, [b.checklistItemId]);
          if (it.rows[0]) { condLabel = it.rows[0].label; where = ` to condition "${condLabel}"${slot ? ` — ${slot}` : ''}`; }
        } else if (slot) where = ` — ${slot}`;
        const ctx = await notify.fileContext(b.applicationId);
        const opts = {
          type: 'doc_uploaded',
          // Specific subject: the condition it answers (or the filename), so the
          // reader knows exactly WHAT arrived before opening the email.
          title: condLabel ? `Document uploaded for "${condLabel}"` : `Document uploaded: ${b.filename}`,
          body: `${who} uploaded "${b.filename}"${where} on ${ctx ? ctx.label : 'the file'}.`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: b.applicationId,
          link: `/internal/app/${b.applicationId}`,
          ctaLabel: 'Review the document',
          // Attach the document itself so the loan team can review it straight
          // from the email (owner-directed). Always LIST the file; attach the
          // bytes only when small enough for the mail providers (Graph caps inline
          // attachments ~3 MB) — larger files are still one tap away in the portal.
          files: [b.filename],
          // Re-encode the DECODED bytes (never the raw client payload): the
          // stored document and the emailed copy must be the same bytes.
          attachments: buf.length <= 3 * 1024 * 1024
            ? [{ filename: b.filename, contentType: b.contentType || 'application/octet-stream', content: buf.toString('base64') }]
            : undefined,
        };
        await notify.notifyAppStaff(b.applicationId, opts);   // #113: whole team (primary + assistants)
      }
    } catch (_) { /* never fail the upload on a notify hiccup */ }
  }
});

// List the borrower's own documents (optionally scoped to one application).
// Only borrower-visible items, and never chat attachments — those render inside
// the conversation, not the document library (see 014_document_visibility).
router.get('/documents', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,application_id,llc_id,checklist_item_id,slot_label,doc_kind,created_at,
            review_status,rejection_reason,is_current
       FROM documents
      WHERE borrower_id=$1 AND ($2::uuid IS NULL OR application_id=$2)
        AND visibility='borrower' AND source_type <> 'chat_attachment'
      ORDER BY is_current DESC, created_at DESC`,
    [me(req), req.query.applicationId || null]);
  // rejection_reason AND slot_label are staff free-text shown to the borrower —
  // scrub any capital-partner name out of both.
  res.json(r.rows.map((row) => scrubFields(row, ['rejection_reason', 'slot_label'])));
});

// Download a document the borrower may see: their own uploads plus staff files
// shared with them on the borrower channel, on an application they own or
// co-borrow, plus the vesting LLC's documents on a file they co-borrow.
// visibility='borrower' is mandatory — a borrower must never be able
// to fetch a staff-only / internal document even with a guessed id.
router.get('/documents/:id/download', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,storage_ref FROM documents
      WHERE id=$1 AND visibility='borrower' AND (borrower_id=$2 OR application_id IN
        (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$2")})
        OR (llc_id IS NOT NULL AND llc_id IN
          (SELECT llc_id FROM applications WHERE (${OWN_FILE_SQL("", "$2")}) AND llc_id IS NOT NULL)))
      -- Co-borrower privacy (#82): having access to the shared FILE does not grant
      -- access to the OTHER borrower's PERSONAL uploads (their government ID, bank
      -- statements, etc.). Only serve a document that is the caller's own, is not
      -- tied to a person (file-level), is a shared vesting-entity doc, or is a
      -- staff/tool-produced file artifact.
      AND (borrower_id=$2 OR borrower_id IS NULL OR llc_id IS NOT NULL
           OR uploaded_by_kind='staff' OR source_type='system')`,
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
  catch (e) { console.error('[plaid]', e && e.message); res.status(502).json({ error: 'bank verification is temporarily unavailable — please try again.' }); }
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
  } catch (e) { console.error('[plaid]', e && e.message); res.status(502).json({ error: 'bank verification is temporarily unavailable — please try again.' }); }
});

// ---------------- NOTIFICATIONS ----------------
router.get('/notifications', async (req, res) => {
  const r = await db.query(
    `SELECT id,type,title,body,application_id,link,read_at,created_at FROM notifications
     WHERE borrower_id=$1 ORDER BY created_at DESC LIMIT 100`, [me(req)]);
  // Some notification rows are written directly (chat bell) bypassing the
  // notify.notifyBorrower scrub — scrub title/body on the way out (covers
  // already-stored rows too).
  res.json(r.rows.map((row) => scrubFields(row, ['title', 'body'])));
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
    // With no saved preference, show the category's REAL email default (major
    // moments email; routine/other categories don't) instead of always "on".
    email: byCat[category] ? byCat[category].email : notify.categoryEmailsByDefault(category),
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
             (SELECT id FROM applications WHERE ${OWN_FILE_SQL("", "$1")}))
      ORDER BY m.created_at DESC LIMIT 500`,
    [me(req), req.query.applicationId || null]);
  r.rows.reverse();   // newest-500 window, still rendered oldest-first
  for (const m of r.rows) if (m && typeof m.body === 'string') m.body = scrubText(m.body);  // no partner name to a borrower
  // Opening the thread clears the "new message" badge for staff replies —
  // legacy read_at plus the new per-member watermark (035).
  if (req.query.applicationId) {
    await db.query(`UPDATE messages SET read_at=now() WHERE application_id=$1 AND borrower_id=$2 AND sender_kind='staff' AND read_at IS NULL`,
      [req.query.applicationId, me(req)]);
    try {
      const chatLib = require('../lib/chat');
      const c = await db.query(`SELECT id FROM conversations WHERE application_id=$1 AND kind='borrower'`, [req.query.applicationId]);
      if (c.rows[0]) {
        const conv = await chatLib.getConversation(c.rows[0].id);
        const mx = await db.query(`SELECT COALESCE(max(seq),0) AS s FROM messages WHERE conversation_id=$1`, [conv.id]);
        if (Number(mx.rows[0].s)) await chatLib.markRead(conv, { kind: 'borrower', id: me(req) }, Number(mx.rows[0].s));
      }
    } catch (_) { /* legacy path stays best-effort */ }
  }
  res.json(r.rows);
});
router.post('/messages', async (req, res) => {
  const b = req.body || {};
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  if (!b.applicationId) return res.status(400).json({ error: 'applicationId required' });
  // Must be the borrower's own file — never let a borrower post onto another
  // borrower's file by guessing its id.
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [b.applicationId, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'application not found' });

  // Legacy contract, new engine: delegate onto the file's borrower chat so the
  // watermark receipts, SSE fan-out and notification ladder all run.
  const chatLib = require('../lib/chat');
  await chatLib.ensureConversationsForApp(b.applicationId);
  const c = await db.query(`SELECT id FROM conversations WHERE application_id=$1 AND kind='borrower'`, [b.applicationId]);
  if (!c.rows[0]) return res.status(404).json({ error: 'conversation not found' });
  const conv = await chatLib.getConversation(c.rows[0].id);
  try {
    const { message } = await chatLib.postMessage({
      conv, actor: { kind: 'borrower', id: me(req) },
      body: b.body, attachment: att, entityRefs: b.entityRefs, isTaskRequest: !!b.isTaskRequest,
    });
    res.status(201).json({ ok: true, messageId: message.id });
  } catch (e) {
    if (e.code === 'pii_blocked') return res.status(400).json({ error: e.message });
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' });
  }
});

// Toggle an emoji reaction on a borrower-channel message on one of my files.
router.post('/messages/:mid/react', async (req, res) => {
  const emoji = String((req.body || {}).emoji || '').slice(0, 16);
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  const m = await db.query(
    `SELECT 1 FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND (${OWN_FILE_SQL("a", "$2")})`,
    [req.params.mid, me(req)]);
  if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
  const del = await db.query(
    `DELETE FROM message_reactions WHERE message_id=$1 AND actor_kind='borrower' AND actor_id=$2 AND emoji=$3 RETURNING id`,
    [req.params.mid, me(req), emoji]);
  if (!del.rows[0])
    await db.query(`INSERT INTO message_reactions (message_id,actor_kind,actor_id,emoji) VALUES ($1,'borrower',$2,$3)`,
      [req.params.mid, me(req), emoji]);
  try {
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) {
      const fresh = await require('../lib/chat').getMessage(req.params.mid);
      require('../lib/events').publishToConversation(convId, 'reaction:update',
        { conversationId: convId, messageId: req.params.mid, reactions: fresh.reactions }).catch(() => {});
    }
  } catch (_) {}
  res.json({ ok: true, reacted: !del.rows[0] });
});

// Edit my own message (within 15 min). Only borrower-channel, my own file.
router.patch('/messages/:mid', async (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  const m = await db.query(
    `SELECT m.created_at, m.deleted_at FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND m.sender_kind='borrower' AND m.sender_id=$2
        AND (${OWN_FILE_SQL("a", "$2")})`, [req.params.mid, me(req)]);
  if (!m.rows[0] || m.rows[0].deleted_at) return res.status(404).json({ error: 'not found' });
  if ((Date.now() - new Date(m.rows[0].created_at).getTime()) > 15 * 60 * 1000)
    return res.status(403).json({ error: 'this message can no longer be edited' });
  // Pre-edit body goes to the append-only revision trail (audit/discovery).
  await db.query(
    `INSERT INTO message_revisions (message_id, body, edited_by_kind, edited_by_id)
     SELECT id, body, 'borrower', $2 FROM messages WHERE id=$1`, [req.params.mid, me(req)]);
  await db.query(`UPDATE messages SET body=$2, edited_at=now() WHERE id=$1`, [req.params.mid, body.slice(0, 4000)]);
  try {
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) {
      const fresh = await require('../lib/chat').getMessage(req.params.mid);
      require('../lib/events').publishToConversation(convId, 'message:edited',
        { conversationId: convId, message: fresh }).catch(() => {});
    }
  } catch (_) {}
  res.json({ ok: true });
});
// Soft-delete my own message.
router.delete('/messages/:mid', async (req, res) => {
  const m = await db.query(
    `SELECT 1 FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND m.sender_kind='borrower' AND m.sender_id=$2
        AND (${OWN_FILE_SQL("a", "$2")})`, [req.params.mid, me(req)]);
  if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
  // Tombstone with the pre-delete body preserved in the revision trail.
  await db.query(
    `INSERT INTO message_revisions (message_id, body, edited_by_kind, edited_by_id)
     SELECT id, body, 'borrower', $2 FROM messages WHERE id=$1`, [req.params.mid, me(req)]);
  await db.query(`UPDATE messages SET deleted_at=now(), body='[message removed]', pinned=false WHERE id=$1`, [req.params.mid]);
  await db.query(`DELETE FROM message_reactions WHERE message_id=$1`, [req.params.mid]);
  try {
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) require('../lib/events').publishToConversation(convId, 'message:deleted',
      { conversationId: convId, messageId: req.params.mid }).catch(() => {});
  } catch (_) {}
  res.json({ ok: true });
});

// What the borrower can mention: their team, their visible tasks, their
// documents, and their own applications/properties.
router.get('/applications/:id/mentionables', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (${OWN_FILE_SQL("", "$2")})`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const [users, tasks, docs, apps] = await Promise.all([
    db.query(`SELECT s.id, s.full_name AS label FROM applications a
                JOIN staff_users s ON s.id IN (a.loan_officer_id, a.processor_id)
               WHERE a.id=$1 AND s.is_active=true`, [req.params.id]),
    db.query(`SELECT id, label, status FROM checklist_items
               WHERE application_id=$1 AND audience IN ('borrower','both') ORDER BY sort_order LIMIT 200`, [req.params.id]),
    // Co-borrower privacy (#82): don't surface the OTHER borrower's personal
    // uploads in the mention list — same rule as the download endpoint.
    db.query(`SELECT id, filename AS label FROM documents WHERE application_id=$1
                AND visibility='borrower' AND source_type <> 'chat_attachment'
                AND (borrower_id=$2 OR borrower_id IS NULL OR llc_id IS NOT NULL
                     OR uploaded_by_kind='staff' OR source_type='system')
              ORDER BY created_at DESC LIMIT 100`, [req.params.id, me(req)]),
    db.query(`SELECT id, COALESCE(property_address->>'oneLine', property_address->>'street', 'Application') AS label
                FROM applications WHERE ${OWN_FILE_SQL("", "$1")}`, [me(req)]),
  ]);
  res.json({ users: users.rows, tasks: tasks.rows, documents: docs.rows, applications: apps.rows });
});

// Which of my applications have unread messages from the loan team.
// Unread now comes from the per-member watermark model (035).
router.get('/chat/inbox', async (req, res) => {
  const r = await db.query(
    `SELECT a.id, a.property_address, a.status,
            COALESCE((SELECT cm.unread_count FROM conversation_members cm
                        JOIN conversations c2 ON c2.id=cm.conversation_id
                       WHERE c2.application_id=a.id AND c2.kind='borrower'
                         AND cm.member_kind='borrower' AND cm.member_id=$1 AND cm.removed_at IS NULL), 0) AS unread,
            lm.body AS last_body, lm.sender_kind AS last_sender_kind, lm.created_at AS last_at
       FROM applications a
       LEFT JOIN LATERAL (SELECT body, sender_kind, created_at FROM messages m
                           WHERE m.application_id=a.id AND m.channel='borrower' AND m.deleted_at IS NULL
                           ORDER BY created_at DESC LIMIT 1) lm ON true
      WHERE ${OWN_FILE_SQL("a", "$1")}
      ORDER BY lm.created_at DESC NULLS LAST`, [me(req)]);
  res.json(r.rows.map((row) => scrubFields(row, ['last_body'])));
});

// ---------------- chat v3: conversations, receipts, presence ----------------
router.use(require('./borrower-chat'));

// ---------------- shared: auto-generate checklist from templates ----------------
// ==================== APPLICATION DRAFTS (save-as-you-go) ====================
// One open draft = one in-progress application. The wizard PUTs the whole
// form-state object as it changes; nothing here touches the pricing engines.

router.get('/drafts', async (req, res) => {
  // Default: active (open, not archived) drafts. `?archived=1` returns the
  // borrower's archived drafts so they can restore or delete them.
  const archived = req.query.archived === '1' || req.query.archived === 'true';
  const r = await db.query(
    `SELECT id,label,step,updated_at,created_at,submitted_application_id,archived_at
       FROM application_drafts
      WHERE borrower_id=$1 AND submitted_application_id IS NULL
        AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}
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
  // Never persist a plaintext SSN into the draft blob (unlike borrowers.ssn,
  // which is AES-encrypted). Strip it here as defense-in-depth; the real SSN is
  // sent on submit and encrypted by syncProfileFromApplication. Keep an
  // ssnProvided flag so a resumed draft still shows the "on file" state.
  const data = { ...(b.data || {}) };
  if ('ssn' in data) { if (data.ssn) data.ssnProvided = true; delete data.ssn; }
  if (data.personal && typeof data.personal === 'object' && 'ssn' in data.personal) {
    const { ssn, ...restPersonal } = data.personal; data.personal = restPersonal;
  }
  const r = await db.query(
    `UPDATE application_drafts
        SET data = data || $3::jsonb,
            step = COALESCE($4, step),
            label = COALESCE($5, label),
            updated_at = now()
      WHERE id=$1 AND borrower_id=$2
      RETURNING id,step,updated_at`,
    [req.params.id, me(req), JSON.stringify(data),
     (b.step == null ? null : b.step), (b.label == null ? null : b.label)]);
  res.json({ ok: true, ...r.rows[0] });
});

// Permanently remove an unsubmitted draft (a submitted one is a real file and
// is never touched here). Owner-scoped; reports whether a row actually went.
router.delete('/drafts/:id', async (req, res) => {
  const r = await db.query(
    `DELETE FROM application_drafts WHERE id=$1 AND borrower_id=$2 AND submitted_application_id IS NULL RETURNING id`,
    [req.params.id, me(req)]);
  res.json({ ok: true, deleted: !!r.rows[0] });
});
// Archive / restore an unsubmitted draft — a reversible hide, so a borrower can
// tidy their in-progress list without losing work.
router.post('/drafts/:id/archive', async (req, res) => {
  const r = await db.query(
    `UPDATE application_drafts SET archived_at=now(), updated_at=now()
      WHERE id=$1 AND borrower_id=$2 AND submitted_application_id IS NULL RETURNING id`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
router.post('/drafts/:id/unarchive', async (req, res) => {
  const r = await db.query(
    `UPDATE application_drafts SET archived_at=NULL, updated_at=now()
      WHERE id=$1 AND borrower_id=$2 AND submitted_application_id IS NULL RETURNING id`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
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
  const hasAny = ['cellPhone', 'dateOfBirth', 'citizenship', 'maritalStatus', 'fico',
                  'currentAddress', 'yearsAtResidence', 'monthsAtResidence', 'housingStatus', 'housingPayment']
    .some(k => p[k] != null && p[k] !== '');
  if (!hasAny && !b.ssn) return;
  const currentAddress = p.currentAddress ? JSON.stringify(p.currentAddress) : null;
  const yearsAtResidence = p.yearsAtResidence === '' || p.yearsAtResidence == null ? null : Number(p.yearsAtResidence);
  const monthsAtResidence = p.monthsAtResidence === '' || p.monthsAtResidence == null ? null : parseInt(p.monthsAtResidence, 10) || null;
  const housingPayment = moneyField(p.housingPayment);
  await db.query(
    `UPDATE borrowers SET
       cell_phone      = COALESCE(cell_phone, NULLIF($2,'')),
       date_of_birth   = COALESCE(date_of_birth, NULLIF($3,'')::date),
       citizenship     = COALESCE(citizenship, NULLIF($4,'')),
       marital_status  = COALESCE(marital_status, NULLIF($5,'')),
       fico            = COALESCE(fico, $6),
       current_address = COALESCE(current_address, $7::jsonb),
       years_at_residence = COALESCE(years_at_residence, $8),
       months_at_residence = COALESCE(months_at_residence, $9),
       housing_status  = COALESCE(housing_status, NULLIF($10,'')),
       housing_payment = COALESCE(housing_payment, $11),
       updated_at      = now()
     WHERE id=$1`,
    [borrowerId, p.cellPhone || '',
     require('../lib/fields').sanitizeDob(p.dateOfBirth) || '',   // typed '26' resolves; fill-only DOB still year-guarded
     p.citizenship || '', p.maritalStatus || '',
     require('../lib/fields').sanitizeFico(p.fico),
     currentAddress, isFinite(yearsAtResidence) ? yearsAtResidence : null,
     monthsAtResidence, p.housingStatus || '', housingPayment]);
  // Leave a HUMAN fingerprint naming the fields (esp. 'date_of_birth'): the DOB
  // backdating provenance check reads the audit trail — the submit-time profile
  // sync previously audited nothing itself, so a DOB the borrower typed on
  // their loan application was invisible to it (post-merge audit #271,
  // provenance hole #2). Best-effort — never blocks a submit.
  try {
    const touched = [];
    if (require('../lib/fields').sanitizeDob(p.dateOfBirth)) touched.push('date_of_birth');
    if (p.cellPhone) touched.push('cell_phone');
    if (p.currentAddress) touched.push('current_address');
    if (touched.length) {
      await db.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('borrower',$1,'profile_synced_from_application','borrower',$1,$2)`,
        [borrowerId, JSON.stringify({ fields: touched })]);
    }
  } catch (_) { /* best-effort */ }
  if (b.ssn) {
    // #91/#92: never persist a partial/garbage SSN from the application; just skip
    // an invalid one (don't fail the submit over it). COALESCE keeps any real SSN.
    const s = C.ssnForStorage(b.ssn);
    if (s) await db.query(
      `UPDATE borrowers SET ssn_encrypted = COALESCE(ssn_encrypted, $2),
              ssn_last4 = COALESCE(ssn_last4, $3), updated_at=now() WHERE id=$1`,
      [borrowerId, s.encrypted, s.last4]);
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
  // N-2 (round-2): if this email is already on file under a DIFFERENT (name-
  // conflicting) borrower — common with shared family emails in this book of
  // business — do NOT silently adopt them onto this file (that would grant a
  // stranger portal access to this borrower's SSN/DOB/documents). Fail closed:
  // skip the co-borrower and leave a traceable audit row for staff to resolve.
  {
    const identity = require('../clickup/identity');
    const em = String(co.email).toLowerCase().trim();
    const ex = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE email=$1 LIMIT 1`, [em])).rows[0];
    if (ex && identity.nameConflict(co.firstName, co.lastName, ex.first_name, ex.last_name)) {
      await db.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system', 'coborrower_email_conflict_blocked', 'application', $1, $2)`,
        [appId, JSON.stringify({ email: em, typed: `${co.firstName || ''} ${co.lastName || ''}`.trim(),
          onFile: `${ex.first_name || ''} ${ex.last_name || ''}`.trim() })]).catch(() => {});
      return null;
    }
  }
  // #97: capture the co-borrower's FICO from the application (sanitized to a
  // valid 3-digit score). Fill only when the co-borrower has NO score yet —
  // COALESCE(existing, new) keeps their OWN canonical FICO (they're a full
  // borrower shared by email), so a primary borrower's guess never overwrites a
  // co-borrower's real score, and a blank never wipes one either.
  const cb = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone,fico)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET updated_at=now(), fico=COALESCE(borrowers.fico, EXCLUDED.fico) RETURNING id`,
    [co.firstName || 'Co-Borrower', co.lastName || '', co.email, co.phone || null,
     require('../lib/fields').sanitizeFico(co.fico)]);
  const coId = cb.rows[0].id;
  // Claim the co-borrower slot ATOMICALLY (audit F-LOW-1): the caller's 409 guard
  // reads co_borrower_id in a separate statement, so two concurrent invites from
  // the same owner could both pass it; an unconditional UPDATE would let the second
  // overwrite the first and strand a borrower. `WHERE co_borrower_id IS NULL` makes
  // the slot single-winner. The draft-submit caller always links onto a fresh
  // (null) app, so this guard is a no-op there.
  const link = await db.query(
    `UPDATE applications SET co_borrower_id=$2, updated_at=now() WHERE id=$1 AND co_borrower_id IS NULL`,
    [appId, coId]);
  if (link.rowCount === 0) { const err = new Error('this file already has a co-borrower'); err.code = 'CO_BORROWER_EXISTS'; throw err; }
  // Existing login? They already have access via co_borrower_id — just notify.
  const hasAuth = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [coId]);
  const token = C.randomToken(24);
  if (!hasAuth.rows[0]) {
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,expires_at)
       VALUES ($1,'borrower',$2, now() + interval '14 days')`, [C.sha256(token), co.email]);
  }
  try {
    // #150 — brand the invite to the FILE's assigned loan officer (From display
    // name + contact block) when one is assigned.
    let officer = null;
    try {
      const o = await db.query(
        `SELECT s.full_name, s.title, s.email, s.phone, s.cell, s.nmls
           FROM applications a JOIN staff_users s ON s.id=a.loan_officer_id WHERE a.id=$1`, [appId]);
      if (o.rows[0]) officer = { name: o.rows[0].full_name, title: o.rows[0].title, email: o.rows[0].email, phone: o.rows[0].cell || o.rows[0].phone, nmls: o.rows[0].nmls };
    } catch (_) { /* officer branding is best-effort */ }
    await mail.send('coBorrowerInvite', co.email, {
      firstName: co.firstName || '',
      primaryName: primaryName || 'your co-borrower',
      acceptUrl: hasAuth.rows[0] ? mail.link('/login') : mail.link('/accept?token=' + token),
      hasAccount: !!hasAuth.rows[0],
      officer,
    }, { replyTo: fileReplyTo(appId), from: officer ? require('../lib/email').fromWithName(officer.name) : null });   // #68 + #150
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
  // A typed-but-never-picked entity name still links a real profile LLC.
  if (!b.llcId && b.entityName) { try { b.llcId = await resolveEntityByName(me(req), b.entityName); } catch (_) { /* best-effort */ } }

  // resolve officer -> null means Lead Capture
  let officerId = null, officerRow = null;
  // LO branding LOCK (owner-directed 2026-07-20): if the borrower already has an
  // OWNING officer (loan officer of record — a prior file's officer, or the
  // officer whose invite link they signed up through, established + backfilled in
  // db/105), the file is LOCKED to that officer. A client-supplied officer — even
  // a crafted or stale-draft value — can NEVER override it. This is the
  // authoritative half of the borrower-side "can't change loan officer" rule (the
  // Apply UI also renders the picker read-only). Populating officerRow here also
  // routes the new-application email to the owning officer (the notify branch
  // keys off officerRow) and keeps the denormalized name consistent.
  const own = await db.query(`SELECT primary_officer_id FROM borrowers WHERE id=$1`, [me(req)]);
  const ownedOid = own.rows[0] && own.rows[0].primary_officer_id;
  if (ownedOid) {
    const o = await db.query(`SELECT id,email,full_name FROM staff_users WHERE id=$1 AND is_active=true`, [ownedOid]);
    if (o.rows[0]) { officerRow = o.rows[0]; officerId = o.rows[0].id; b.loanOfficerName = o.rows[0].full_name; }
  }
  // No owning officer yet → honor the borrower's requested officer (by email,
  // else by name); still null → Lead Capture.
  if (!officerId && b.loanOfficerEmail) {
    const o = await db.query(`SELECT id,email,full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active=true`, [b.loanOfficerEmail]);
    officerRow = o.rows[0] || null;
  }
  if (!officerId && !officerRow && b.loanOfficerName) {
    const o = await db.query(`SELECT id,email,full_name FROM staff_users WHERE lower(full_name)=lower($1) AND is_active=true`, [b.loanOfficerName]);
    officerRow = o.rows[0] || null;
  }
  if (!officerId && officerRow) officerId = officerRow.id;

  // Assignment invariant (mirrors the staff create via the shared helper, #96):
  // hard-null underlying/fee off an assignment and store purchase = underlying +
  // (derived) fee, so the submitted file is internally consistent.
  const asg = require('../lib/fields').assignmentFields(b);
  // sqft only applies to a square-footage / ground-up rehab — null it otherwise
  // so a stale value can't force the pricing sqftAddition flag.
  const sqf = require('../lib/fields').sqftForType(b.rehabType, intField(b.sqftPre) || null, intField(b.sqftPost) || null);
  const ins = await db.query(
    `INSERT INTO applications
       (borrower_id,llc_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
        rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
        is_assignment,underlying_contract_price,assignment_fee,
        term,requested_ir_months,
        requested_exp_reo,payoff_amount,original_purchase_price,acquisition_date,
        requested_ir_amount,
        source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$24,$25,$26,$27,$28,$29,$30,'portal',$23,'new',now())
     RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, require('../lib/fields').sanitizeLoanType(b.loanType), asg.purchasePrice, b.asIsValue || null,   // #95: never a program
     b.arv || null, b.rehabBudget || null, officerId, b.loanOfficerName || null,
     b.rehabType || null, sqf.sqftPre, sqf.sqftPost,
     intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
     asg.isAssignment, asg.underlying, asg.assignFee, JSON.stringify(redactPII(b)),
     b.termMonths ? String(b.termMonths) : null, intField(b.irMonths),
     intField(b.requestedExpReo), moneyField(b.payoffAmount), moneyField(b.originalPurchasePrice),
     require('../lib/fields').normalizeTypedDate(b.acquisitionDate),   // typed '26' resolves to 2026; garbage never persists
     moneyField(b.irAmount)]);
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

  // Invariant chokepoint (root fix 2026-07-14) — inputs derive from the saved row.
  await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'draft_submit' });
  // Auto-apply the saved appraisal card to this new file (no tap) when the
  // borrower previously chose "save to next file". Best-effort; never blocks.
  try { await apprCard.autoApplySavedCardIfOptedIn(appId, me(req)); } catch (_) {}
  await db.query(`UPDATE application_drafts SET submitted_application_id=$1, updated_at=now() WHERE id=$2 AND borrower_id=$3`,
    [appId, req.params.id, me(req)]);
  await audit(req, 'submit_application', 'application', appId);

  // notify staff (branded)
  const addr = (b.propertyAddress && (b.propertyAddress.oneLine || b.propertyAddress.street)) || 'a new property';
  const exp = [b.requestedExpFlips && `${b.requestedExpFlips} flips`, b.requestedExpHolds && `${b.requestedExpHolds} holds`,
               b.requestedExpGround && `${b.requestedExpGround} ground-up`, b.requestedExpReo && `${b.requestedExpReo} REO`]
    .filter(Boolean).join(' · ');
  const ctx = await notify.fileContext(appId, [
    b.propertyType ? { label: 'Property type', value: `${b.propertyType}${b.units ? ` · ${b.units} unit(s)` : ''}` } : null,
    /refi/i.test(b.loanType || '') && b.payoffAmount ? { label: 'Current payoff', value: '$' + Math.round(Number(b.payoffAmount)).toLocaleString('en-US') } : null,
    b.asIsValue ? { label: 'As-is value', value: '$' + Math.round(Number(b.asIsValue)).toLocaleString('en-US') } : null,
    exp ? { label: 'Experience claimed', value: exp } : null,
    b.entityName ? { label: 'Vesting entity', value: b.entityName } : null,
  ].filter(Boolean));
  const meta = (ctx && ctx.meta) || [{ label: 'Property', value: String(addr) }];
  const bodyLine = ctx
    ? `${ctx.borrowerName} submitted ${ctx.loanNo} — ${ctx.addr}${b.program ? ` · ${b.program}` : ''}${b.loanType ? ` · ${b.loanType}` : ''}${b.purchasePrice ? ` · purchase $${Math.round(Number(b.purchasePrice)).toLocaleString('en-US')}` : ''}${b.rehabBudget ? ` · rehab $${Math.round(Number(b.rehabBudget)).toLocaleString('en-US')}` : ''}.`
    : 'A borrower submitted a new loan application through the portal.';
  try {
    if (officerRow) {
      await notify.notifyStaff(officerId, {
        type: 'new_application', title: 'New application submitted',   // loan# rides in the subject tag — not doubled in the title
        body: bodyLine,
        applicationId: appId, link: `/internal/app/${appId}`, meta,
        emailTo: officerRow.email, ctaLabel: 'Open the loan file',
      });
    } else {
      await notify.notifyAdmins({
        type: 'unassigned_application', title: 'New application — Lead Capture',   // loan# rides in the subject tag — not doubled in the title
        body: bodyLine + ' No loan officer was selected — it is in Lead Capture.',
        applicationId: appId, link: `/internal`, meta, ctaLabel: 'Open Lead Capture',
      });
    }
  } catch (e) { /* notification failure never blocks submission */ }

  // Create + link the ClickUp task in the correct folder on file-start (#92).
  require('../clickup/orchestrator').createForNewFile(appId).catch((e) => console.error('[clickup] create-on-start (draft submit)', appId, e && e.message));
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
  // Idempotency: never create a second copy of the same template for the same
  // owner (application / borrower_profile / llc). This lets generateChecklist run
  // repeatedly — a ClickUp re-ingest, a self-serve re-sync, or the RTL backfill —
  // and only fill genuine gaps rather than duplicating a file's conditions. On a
  // brand-new file there are no items yet, so the create path is unchanged.
  const [ownerCol, ownerVal] = Object.entries(owner)[0] || [];
  if (ownerCol && ownerVal != null) {
    const existing = await db.query(
      `SELECT 1 FROM checklist_items WHERE template_id=$1 AND ${ownerCol}=$2 LIMIT 1`, [tpl.id, ownerVal]);
    if (existing.rows[0]) return;
  }
  const cols = ['template_id', 'scope', 'label', 'borrower_label', 'audience', 'item_kind',
                'role_scope', 'phase', 'hint', 'borrower_hint', 'is_gate', 'is_milestone',
                'sort_order', 'tool_key', 'clickup_field_id', 'tpr_exclude', 'created_by_kind', 'is_required'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.borrower_label || null, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null, tpl.borrower_hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, tpl.tpr_exclude || false, 'system',
                tpl.is_required !== false];
  for (const [k, v] of Object.entries(owner)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await db.query(`INSERT INTO checklist_items (${cols.join(',')}) VALUES (${ph})`, vals);
}

async function generateChecklist(appId, borrowerId, program, loanType, opts = {}) {
  const track = normLoanType([program, loanType].join(' '));
  // Ground-up build? Drives the "Plans & permits (if applicable)" placeholder
  // condition. Read the file itself so every caller gets the same answer.
  let groundUp = /ground/i.test([program, loanType].join(' '));
  if (!groundUp) {
    try {
      const a = await db.query(`SELECT rehab_type, loan_type, program FROM applications WHERE id=$1`, [appId]);
      if (a.rows[0]) groundUp = /ground/i.test([a.rows[0].rehab_type, a.rows[0].loan_type, a.rows[0].program].join(' '));
    } catch (_) { /* best-effort */ }
  }
  // auto_apply IS NULL = legacy templates instantiated here at creation.
  // Templates managed by the Condition Center engine (auto_apply set) are
  // attached/retracted by evaluateApplication() below instead.
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE is_active=true AND scope IN ('application','borrower_profile')
       AND auto_apply IS NULL
       AND (applies_program IS NULL OR applies_program=$1)
       AND (applies_loan_type IS NULL OR applies_loan_type=$2)
     ORDER BY sort_order`, [program || null, track]);
  for (const tpl of t.rows) {
    // Assignment paperwork is only required when the purchase is an assignment.
    if (tpl.code === 'rtl_p5_assign' && !opts.isAssignment) continue;
    // Plans & permits placeholder only exists on ground-up construction files.
    if (tpl.code === 'rtl_p1_plans' && !groundUp) continue;
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
  // The vesting LLC drives the file's LLC condition from day one: a verified
  // entity auto-satisfies it (signed off), an in-progress one starts it in the
  // matching state (in review / needs attention / outstanding).
  try {
    const av = await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [appId]);
    if (av.rows[0] && av.rows[0].llc_id) await llcLib.syncLlcConditions(av.rows[0].llc_id, { appId });
  } catch (_) { /* best-effort */ }
  try { await syncExperienceChecklistForApplication(appId); } catch (_) { /* best-effort */ }
  // Condition Center: attach every matching rule/always definition. The new
  // file's items were just created, so skip the borrower notification — the
  // borrower is looking at the fresh checklist already.
  try { await conditionEngine.evaluateApplication(appId, { reason: 'application_created', notify: false }); } catch (_) { /* best-effort */ }
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

// One-shot backfill: apply the RTL condition set + internal checklist to every
// ACTIVE or CLOSED (funded) RTL file that is missing items — including files
// imported from ClickUp and manually-entered files. Cancelled (withdrawn/declined)
// and deleted files are skipped. generateChecklist is idempotent (insertFromTemplate
// dedups per template+owner), so this only fills genuine gaps. Guarded by a
// data_migrations marker so it runs once; bump the key to re-run after adding
// templates. `version` lets a later template addition force a fresh pass.
const RTL_PROGRAMS_BACKFILL = ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction'];
async function backfillRtlChecklists(version = 'v1') {
  const key = `backfill_rtl_checklists_${version}`;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS data_migrations (key text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = await db.query(`SELECT 1 FROM data_migrations WHERE key=$1`, [key]);
    if (done.rows[0]) return { skipped: true };
    const files = await db.query(
      `SELECT id, borrower_id, program, loan_type FROM applications
        WHERE deleted_at IS NULL
          AND status NOT IN ('declined','withdrawn')
          AND program = ANY($1::text[])
        ORDER BY created_at`, [RTL_PROGRAMS_BACKFILL]);
    let filled = 0;
    for (const f of files.rows) {
      try { await generateChecklist(f.id, f.borrower_id, f.program, f.loan_type, {}); filled++; }
      catch (e) { console.error('[checklist-backfill] file', f.id, e.message); }
    }
    await db.query(`INSERT INTO data_migrations(key) VALUES ($1) ON CONFLICT DO NOTHING`, [key]);
    console.log(`[checklist-backfill] ${key}: processed ${filled}/${files.rows.length} RTL files`);
    return { processed: filled, total: files.rows.length };
  } catch (e) { console.error('[checklist-backfill]', e.message); return { error: e.message }; }
}

// ---------------- #103 borrower self-service pricing ----------------
// The borrower prices loans / builds term sheets in the SAME frozen Term Sheet
// Studio tool the staff use (embedded as an iframe) — the pricing engine and
// guidelines are never reimplemented here. This adds only the SAVE/RESTORE layer
// around it: a borrower can save a scenario (the studio's input set) and reopen
// it later without retyping. Pricing is computed client-side by the frozen
// engine; we persist inputs only.

// Prefill the studio from the borrower's own experience of record: the count of
// their recorded deals in the frozen 36-month exit window, bucketed flip / hold /
// ground — editable in the tool, but a sensible starting point (no application
// required, so it works before they ever file). Never exposes internal margin.
router.get('/pricing/prefill', async (req, res) => {
  try {
    const tr = await db.query(
      `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
         FROM track_records WHERE borrower_id=$1 AND (${RECENT_EXIT_SQL}) GROUP BY 1`, [me(req)]);
    const exp = { flips: 0, holds: 0, ground: 0 };
    for (const row of tr.rows) {
      if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) exp.ground += row.n;
      else if (row.dt.indexOf('flip') > -1) exp.flips += row.n;
      else exp.holds += row.n;
    }
    const b = await db.query(`SELECT first_name, last_name, fico FROM borrowers WHERE id=$1`, [me(req)]);
    const row = b.rows[0] || {};
    res.json({
      exp,
      fico: row.fico || null,
      borrowerName: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

const scenarioLabel = (v) => String(v == null ? '' : v).trim().slice(0, 120) || 'Untitled scenario';
const scenarioInputs = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};

router.get('/pricing/scenarios', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, label, inputs, created_at, updated_at FROM borrower_pricing_scenarios
        WHERE borrower_id=$1 ORDER BY updated_at DESC LIMIT 100`, [me(req)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/pricing/scenarios', async (req, res) => {
  const b = req.body || {};
  try {
    const r = await db.query(
      `INSERT INTO borrower_pricing_scenarios (borrower_id, label, inputs)
       VALUES ($1,$2,$3::jsonb) RETURNING id, label, inputs, created_at, updated_at`,
      [me(req), scenarioLabel(b.label), JSON.stringify(scenarioInputs(b.inputs))]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.put('/pricing/scenarios/:id', async (req, res) => {
  const b = req.body || {};
  try {
    // Only the borrower's own scenario, and only the fields provided.
    const r = await db.query(
      `UPDATE borrower_pricing_scenarios
          SET label  = COALESCE($3, label),
              inputs = COALESCE($4::jsonb, inputs),
              updated_at = now()
        WHERE id=$1 AND borrower_id=$2
        RETURNING id, label, inputs, created_at, updated_at`,
      [req.params.id, me(req),
       b.label !== undefined ? scenarioLabel(b.label) : null,
       b.inputs !== undefined ? JSON.stringify(scenarioInputs(b.inputs)) : null]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.delete('/pricing/scenarios/:id', async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM borrower_pricing_scenarios WHERE id=$1 AND borrower_id=$2 RETURNING id`,
      [req.params.id, me(req)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- e-signature: the borrower's "Sign now" surface -------------
// A SANITIZED view of the borrower's own signing packages + an endpoint to mint
// their embedded (in-portal) signing URL. Never exposes the admin counter-
// signer's email/IP, and never says "binding" before the counter-signature (the
// UI copy handles that). The borrower may only ever mint THEIR OWN recipient
// view — matched on esign_recipients.borrower_id.
const esignDocusign = require('../lib/integrations/docusign');

// Confirm the file is the borrower's, and return its id (or null).
async function ownFileId(req, appId) {
  const r = await db.query(
    `SELECT id FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${OWN_FILE_SQL('a', '$2')} LIMIT 1`,
    [appId, me(req)]);
  return r.rows.length ? r.rows[0].id : null;
}

// Borrower-facing package status (sanitized). One row per in-flight/recent envelope.
router.get('/applications/:id/esign', async (req, res) => {
  try {
    if (!(await ownFileId(req, req.params.id))) return res.status(404).json({ error: 'not found' });
    const rows = (await db.query(
      `SELECT e.id AS envelope_row_id, e.purpose, e.status, e.countersign_required,
              e.envelope_id IS NOT NULL AS sent,
              (SELECT json_agg(json_build_object(
                  'role', r.role, 'firstName', split_part(r.name,' ',1),
                  'signed', (r.signed_at IS NOT NULL OR r.status IN ('completed','signed')),
                  'declined', (r.declined_at IS NOT NULL OR r.status='declined'),
                  'routingOrder', r.routing_order,
                  'mine', (r.borrower_id = $2)) ORDER BY r.routing_order, r.role)
                FROM esign_recipients r WHERE r.envelope_row_id = e.id) AS recipients
         FROM esign_envelopes e
        WHERE e.application_id = $1 AND e.purpose IS NOT NULL
        ORDER BY e.created_at DESC`, [req.params.id, me(req)])).rows;
    const packages = rows.map((e) => {
      const recips = e.recipients || [];
      const mine = recips.find((r) => r.mine);
      const open = ['sent', 'delivered'].includes(e.status);
      const canSignNow = !!(mine && open && !mine.signed && !mine.declined);
      let yourStatus = 'none';
      if (mine) {
        if (mine.declined) yourStatus = 'declined';
        else if (e.status === 'completed') yourStatus = 'completed';
        else if (e.status === 'voided') yourStatus = 'voided';
        else if (mine.signed) yourStatus = 'you_signed_waiting';
        else if (open) yourStatus = 'sign_now';
      }
      // The other party we're waiting on, sanitized (never the admin's identity).
      const coPending = recips.find((r) => r.role === 'co_borrower' && !r.signed && !r.declined);
      const adminPending = e.countersign_required && recips.some((r) => r.role === 'admin' && !r.signed && !r.declined);
      return {
        envelopeRowId: e.envelope_row_id, purpose: e.purpose, status: e.status,
        countersignRequired: e.countersign_required, canSignNow, yourStatus,
        hasCoBorrower: recips.some((r) => r.role === 'co_borrower'),
        waitingOnCoBorrower: !!(mine && mine.signed && coPending),
        waitingOnLender: !!(mine && mine.signed && !coPending && adminPending),
        coBorrowerName: coPending ? coPending.firstName : null,
      };
    });
    res.json({ packages });
  } catch (e) {
    // Log the DB detail server-side; the borrower gets a plain, non-leaking message.
    console.warn(`[esign] borrower esign list failed (app ${req.params.id}): ${db.describeError ? db.describeError(e) : e && e.message}`);
    res.status(500).json({ error: 'We couldn’t load your documents just now. Please refresh and try again.' });
  }
});

// Mint the borrower's own embedded signing URL (single-use, ~5 min).
router.post('/applications/:id/esign/sign-view', async (req, res) => {
  try {
    if (!(await ownFileId(req, req.params.id))) return res.status(404).json({ error: 'not found' });
    const rowId = String((req.body && req.body.envelopeRowId) || '');
    const rec = (await db.query(
      `SELECT r.recipient_id_ds, r.name, r.email, r.client_user_id, e.envelope_id, e.status
         FROM esign_recipients r JOIN esign_envelopes e ON e.id = r.envelope_row_id
        WHERE e.id = $1 AND e.application_id = $2 AND r.borrower_id = $3
        LIMIT 1`, [rowId, req.params.id, me(req)])).rows[0];
    if (!rec) return res.status(404).json({ error: 'no signing task for you on this package' });
    if (!rec.envelope_id) return res.status(409).json({ error: 'this package has not been sent yet' });
    if (!['sent', 'delivered'].includes(rec.status)) return res.status(409).json({ error: 'this package is no longer open for signing' });
    const returnUrl = `${cfg.appUrl}/api/esign/return?app=${encodeURIComponent(req.params.id)}&env=${encodeURIComponent(rec.envelope_id)}&dest=borrower`;
    const url = await esignDocusign.createRecipientView(rec.envelope_id, {
      returnUrl, email: rec.email, userName: rec.name,
      clientUserId: rec.client_user_id, recipientId: rec.recipient_id_ds,
    });
    await audit(req, 'esign_sign_view', 'application', req.params.id);
    res.json({ url });
  } catch (e) {
    // Never leak the internal DocuSign/DB transport error to the borrower — log it
    // server-side and show a friendly, actionable message. (The signer/turn/sent
    // checks above already returned their own clear messages before we got here.)
    console.warn(`[esign] borrower sign-view failed (app ${req.params.id}): ${e && e.message}`);
    res.status(500).json({ error: 'We couldn’t open your signing session just now. Please try again in a moment — or use the signing link in the email we sent you.' });
  }
});

router.generateChecklist = generateChecklist;
router.generateLlcChecklist = generateLlcChecklist;
module.exports = router;
module.exports.generateChecklist = generateChecklist;
module.exports.backfillRtlChecklists = backfillRtlChecklists;
module.exports.generateLlcChecklist = generateLlcChecklist;
module.exports.trackRecordErrors = trackRecordErrors;
module.exports.trackRecordCols = trackRecordCols;
module.exports.trackRecordMissing = trackRecordMissing;
