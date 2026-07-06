/**
 * Borrower-facing API (all endpoints require a borrower token; everything is
 * scoped to req.actor.id so a borrower can only ever see their own data).
 *   Profile · Applications (many, per-address) · LLCs+docs · Track records
 *   · Checklists (borrower-visible) · Documents · Notifications · Messages
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const storage = require('../lib/storage');
const { requireAuth, requireBorrower } = require('../auth');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { redactPII } = require('../lib/redact');
const { serveDocument } = require('../lib/serve-document');
const pricing = require('../lib/pricing');
const { persistProductRegistration } = require('../lib/product-registration');
const { syncExperienceChecklistForApplication, syncExperienceChecklistForBorrower } = require('../lib/experience');
const llcLib = require('../lib/llc');

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
async function audit(req, action, entity_type, entity_id, detail) {
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
     VALUES ('borrower',$1,$2,$3,$4,$5,$6,$7)`,
    [me(req), action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, detail || null]);
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
      filename: String(a.filename || 'tool-export.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 160),
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
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  for (const a of attachments) {
    const buf = Buffer.from(a.dataBase64, 'base64');
    if (!buf.length || buf.length > maxBytes) continue;
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
  return out;
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
// Passing applicationId links the ID to that file's gov-ID condition too, so an
// upload made FROM a file's conditions list lands on the profile AND the file.
router.post('/profile/photo-id', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  let appId = null, appItemId = null;
  if (b.applicationId) {
    const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [b.applicationId, me(req)]);
    if (!own.rows[0]) return res.status(404).json({ error: 'application not found' });
    appId = b.applicationId;
    const it = await db.query(
      `SELECT id FROM checklist_items
        WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id') LIMIT 1`, [appId]);
    appItemId = it.rows[0] ? it.rows[0].id : null;
  }
  try {
    const { ref, provider } = await storage.save(buf, { filename: b.filename });
    const d = await db.query(
      `INSERT INTO documents (borrower_id,application_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
       VALUES ($1,$7,$8,$2,$3,$4,$5,$6,'borrower',$1,'photo_id') RETURNING id`,
      [me(req), b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, appId, appItemId]);
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
        applicationId: a.id, link: `/internal/app/${a.id}`, ctaLabel: 'Open the file' });
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

// A free-typed vesting entity (name only, never picked from the list) still
// becomes a real profile LLC: match one of the borrower's entities by name,
// else create it — so the file always links a real entity and the LLC
// condition never has to re-ask for a name the borrower already gave.
async function resolveEntityByName(borrowerId, name) {
  const nm = String(name || '').trim().slice(0, 160);
  if (!nm) return null;
  const hit = await db.query(
    `SELECT id FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2) LIMIT 1`, [borrowerId, nm]);
  if (hit.rows[0]) return hit.rows[0].id;
  const ins = await db.query(
    `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, nm]);
  try { await generateLlcChecklist(ins.rows[0].id); } catch (_) { /* best-effort */ }
  return ins.rows[0].id;
}

router.post('/applications', async (req, res) => {
  const b = req.body || {};
  if (!b.propertyAddress) return res.status(400).json({ error: 'propertyAddress required' });
  if (b.llcId) { const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]); if (!o.rows[0]) b.llcId = null; }
  if (!b.llcId && b.entityName) { try { b.llcId = await resolveEntityByName(me(req), b.entityName); } catch (_) { /* best-effort */ } }
  const r = await db.query(
    `INSERT INTO applications
       (borrower_id,llc_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_name,
        rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
        is_assignment,underlying_contract_price,assignment_fee,source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'portal',$22,'new',now()) RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, b.loanOfficerName || null,
     b.rehabType || null, intField(b.sqftPre) || null, intField(b.sqftPost) || null,
     intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
     !!b.isAssignment, b.underlyingContractPrice || null, b.assignmentFee || null, JSON.stringify(redactPII(b))]);
  const appId = r.rows[0].id;
  await generateChecklist(appId, me(req), b.program, b.loanType, { isAssignment: !!b.isAssignment });
  await audit(req, 'create_application', 'application', appId);
  res.status(201).json({ ok: true, applicationId: appId });
});

router.get('/applications/:id', async (req, res) => {
  const r = await db.query(
    `SELECT a.*, l.llc_name, l.is_verified AS llc_verified, l.formation_state AS llc_formation_state,
            pr.program AS registered_program, pr.product_label AS registered_product_label,
            pr.status AS registered_product_status, pr.note_rate AS registered_note_rate,
            pr.total_loan AS registered_total_loan, pr.quote AS registered_quote,
            pr.created_at AS registered_at,
            EXISTS(SELECT 1 FROM staff_users s
                    WHERE s.id IN (a.loan_officer_id, a.processor_id)
                      AND s.last_seen_at > now() - interval '2 minutes') AS team_online
       FROM applications a
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN LATERAL (
         SELECT program, product_label, status, note_rate, total_loan, quote, created_at
           FROM product_registrations
          WHERE application_id=a.id AND is_current
          ORDER BY created_at DESC LIMIT 1
       ) pr ON true
      WHERE a.id=$1 AND (a.borrower_id=$2 OR a.co_borrower_id=$2) AND a.deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

async function loadFileForPricing(appId, borrowerId) {
  const a = await db.query(
    `SELECT a.*, b.fico
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.id=$1 AND (a.borrower_id=$2 OR a.co_borrower_id=$2) AND a.deleted_at IS NULL`,
    [appId, borrowerId]);
  const app = a.rows[0];
  if (!app) return null;
  const tr = await db.query(
    `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
       FROM track_records WHERE borrower_id=$1 AND is_verified=true GROUP BY 1`, [app.borrower_id]);
  const exp = { flips: 0, holds: 0, ground: 0 };
  for (const row of tr.rows) {
    if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) exp.ground += row.n;
    else if (row.dt.indexOf('flip') > -1) exp.flips += row.n;
    else exp.holds += row.n;
  }
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
  if (raw && raw.irMonths != null && raw.irMonths !== '') { const v = clamp(raw.irMonths, 0, 24); if (v != null) out.irMonths = Math.round(v); }
  if (raw && raw.term != null && raw.term !== '') { const v = clamp(raw.term, 1, 36); if (v != null) out.term = Math.round(v); }
  if (raw && raw.fico != null && raw.fico !== '') { const v = clamp(raw.fico, 300, 850); if (v != null) out.fico = Math.round(v); }
  for (const k of ['expFlips', 'expHolds', 'expGround']) {
    if (raw && raw[k] != null && raw[k] !== '') { const v = clamp(raw[k], 0, 999); if (v != null) out[k] = Math.round(v); }
  }
  return out;
}
// Admin pricing unlock: a borrower session that presents the admin key (the
// Term Sheet Studio's admin-mode password, server-verified) may also send the
// staff-grade fee / markup / manual-basis overrides.
const ADMIN_OVERRIDE_KEYS = ['markupStdPct', 'markupGoldPct', 'origStdPct', 'origGoldPct',
  'lenderFee', 'creditFee', 'appraisalFee', 'titleFee',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths'];
function mergeAdminOverrides(overrides, raw, adminKey) {
  if (!adminKey || adminKey !== cfg.adminPricingKey) return overrides;
  for (const k of ADMIN_OVERRIDE_KEYS) {
    if (raw && raw[k] != null && raw[k] !== '') overrides[k] = raw[k];
  }
  if (raw && raw.manualPricing != null) overrides.manualPricing = !!raw.manualPricing;
  return overrides;
}

router.get('/applications/:id/pricing', async (req, res) => {
  try {
    const f = await loadFileForPricing(req.params.id, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const hist = await db.query(
      `SELECT r.id, r.program, r.product_label, r.status, r.note_rate, r.total_loan, r.target_ltc,
              r.is_current, r.created_at, r.quote, s.full_name AS registered_by_name
         FROM product_registrations r LEFT JOIN staff_users s ON s.id=r.registered_by
        WHERE r.application_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    // Strip internal lender pricing (markup/spread) from anything sent to a
    // borrower — a staff-created registration's quote embeds it.
    const stripInternal = (q) => { if (q && typeof q === 'object') { const { adminPricing, ...rest } = q; return rest; } return q; };
    const redactRow = (row) => row ? { ...row, quote: stripInternal(row.quote) } : row;
    const history = hist.rows.map(redactRow);
    const current = history.find((x) => x.is_current) || null;
    let quote = null;
    if (pricing.enginesReady()) { try { quote = pricing.quoteAll(f.app, f.exp); quote.experience = f.exp; } catch (_) {} }
    res.json({ current, history, quote, enginesReady: pricing.enginesReady() });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

router.post('/applications/:id/pricing/quote', async (req, res) => {
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadFileForPricing(req.params.id, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const overrides = mergeAdminOverrides(
      borrowerPricingOverrides((req.body && req.body.overrides) || {}),
      (req.body && req.body.overrides) || {}, req.body && req.body.adminKey);
    const out = pricing.quoteAll(f.app, f.exp, overrides);
    res.json({ ...out, experience: f.exp });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

router.post('/applications/:id/pricing/register', async (req, res) => {
  const appId = req.params.id;
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadFileForPricing(appId, me(req));
    if (!f) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const program = b.program === 'gold' ? 'gold' : 'standard';
    const overrides = mergeAdminOverrides(borrowerPricingOverrides(b.overrides || {}), b.overrides || {}, b.adminKey);
    // A REGISTERED product is authoritative terms. Never let borrower-claimed
    // experience beat the verified track record here — staff loan officers are
    // forbidden from injecting these same keys (ADMIN_ONLY_OVERRIDE_KEYS), so a
    // borrower (least privileged) must not be able to either. The what-if /quote
    // path may keep them; the registered basis uses verified experience only.
    delete overrides.expFlips; delete overrides.expHolds; delete overrides.expGround;
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    const quote = pricing.quoteProgram(program, inputs);
    if (quote.status === 'INELIGIBLE') return res.status(422).json({ error: 'ineligible', reasons: quote.reasons, quote });
    const total = quote.sizing ? quote.sizing.totalLoan : 0;
    if (!(total > 0)) return res.status(422).json({ error: 'no loan sized', quote });

    const client = await db.getClient();
    let regId;
    try {
      await client.query('BEGIN');
      regId = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: null,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null });

    // Registering the product satisfies the "Products & pricing" condition.
    try {
      await db.query(
        `UPDATE checklist_items SET status='received', updated_at=now()
          WHERE application_id=$1 AND tool_key='product_pricing' AND status <> 'satisfied'`, [appId]);
    } catch (_) { /* condition may not exist on older files */ }

    try {
      const t = await db.query(`SELECT loan_officer_id, processor_id, ys_loan_number FROM applications WHERE id=$1`, [appId]);
      const row = t.rows[0] || {};
      const rate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : 'n/a';
      const body = `${pricing.PROGRAM_LABEL[program]} selected by borrower: ${money(total)} @ ${rate}`;
      for (const sid of new Set([row.loan_officer_id, row.processor_id].filter(Boolean))) {
        await notify.notifyStaff(sid, {
          type: 'product_registered',
          title: 'Borrower selected a product on ' + (row.ys_loan_number || 'a file'),
          body, applicationId: appId,
          link: `/internal/app/${appId}`,
        });
      }
    } catch (_) {}

    res.status(201).json({ ok: true, registrationId: regId, quote });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
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
  res.json(r.rows);
});

// ---------------- CHECKLIST (borrower-visible items only) ----------------
router.get('/applications/:id/checklist', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  try { await syncExperienceChecklistForApplication(req.params.id); } catch (_) { /* best-effort */ }
  const r = await db.query(
    `SELECT ci.id, COALESCE(ci.borrower_label,ci.label) AS label, ci.status, ci.item_kind, ci.phase,
            COALESCE(ci.borrower_hint,ci.hint) AS hint, ci.is_required, ci.due_date,
            -- ci.notes is the INTERNAL staff note (underwriting / capital-partner
            -- context) — never send it to a borrower. Only the borrower_* wording
            -- above is safe.
            (SELECT code FROM checklist_templates t WHERE t.id=ci.template_id) AS template_code,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            (SELECT d.rejection_reason FROM documents d
              WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
              ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1) AS rejection_reason
       FROM checklist_items ci
      WHERE ci.application_id=$1 AND ci.audience IN ('borrower','both')
      ORDER BY ci.sort_order, ci.created_at`, [req.params.id]);
  res.json(r.rows);
});

// Borrower-safe loan timeline: which milestones the file has reached and when.
// Only the destination status + date (no staff identity, no forced flag).
router.get('/applications/:id/status-history', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT to_status, created_at FROM application_status_history WHERE application_id=$1 ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});

// Borrower completes a tool-backed task (Rehab Budget / Track Record) inside the
// portal. Stores the exported payload and moves the item to 'received' so staff
// can verify and sign off. The borrower is doing "their part" of the file here.
router.post('/applications/:id/checklist/:itemId/tool', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
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
  const notes = (req.body && req.body.notes) ? String(req.body.notes).slice(0, 2000) : null;
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, tool_state=COALESCE($4,tool_state), status='received', notes=COALESCE($3,notes), updated_at=now()
      WHERE id=$1`,
    [req.params.itemId, JSON.stringify(payload), notes,
     payload && typeof payload.state === 'object' ? JSON.stringify(payload.state) : null]);
  // The rehab-budget tool's grand total IS the file's rehab budget, which feeds
  // the pricing engine — sync it onto the application so terms reflect the SOW.
  if (it.rows[0].tool_key === 'rehab_budget') {
    const total = Number(payload && payload.total);
    if (isFinite(total) && total >= 0) {
      await db.query(`UPDATE applications SET rehab_budget=$2, updated_at=now() WHERE id=$1`, [req.params.id, total]);
    }
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
  res.json({ ok: true, status: 'received', exports: storedExports });
});

// ---------------- TOOL STATE (Scope of Work autosave) ----------------
// The static Scope of Work builder autosaves its full state onto the condition
// while the borrower works — reopening the tool restores exactly where they
// left off. Submitting (POST …/tool above) snapshots the state + exports.
router.get('/applications/:id/checklist/:itemId/tool-state', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
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
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
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
  for (const row of r.rows) out.push(await llcLib.getLlcBundle(row.id));
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
      `SELECT 1 FROM applications WHERE llc_id=$1 AND (borrower_id=$2 OR co_borrower_id=$2) AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, me(req)]);
    if (!linked.rows[0]) return res.status(404).json({ error: 'not found' });
  }
  const bundle = await llcLib.getLlcBundle(req.params.id);
  res.json({ ...bundle, read_only: !mine });
});

// Validate a members payload: [{fullName, ownershipPct, email?, phone?}].
// Returns {members, error}. Completion to exactly 100% is a VERIFICATION
// requirement, not a save requirement — partial saves are allowed, but the
// total (borrower + members) may never exceed 100%.
function parseMembers(raw, borrowerPct) {
  if (raw === undefined) return { members: undefined };
  if (!Array.isArray(raw)) return { error: 'members must be an array' };
  if (raw.length > 20) return { error: 'a maximum of 20 members is supported' };
  const members = [];
  for (const m of raw) {
    const fullName = String((m && m.fullName) || '').trim().slice(0, 160);
    const p = Number(m && m.ownershipPct);
    if (!fullName) return { error: 'each member needs a full name' };
    if (!isFinite(p) || p <= 0 || p >= 100) return { error: 'each member needs an ownership % between 0 and 100' };
    members.push({
      fullName, ownershipPct: Math.round(p * 100) / 100,
      email: m.email ? String(m.email).trim().slice(0, 160) : null,
      phone: m.phone ? String(m.phone).trim().slice(0, 40) : null,
    });
  }
  const own = borrowerPct == null ? 0 : Number(borrowerPct) || 0;
  const total = own + members.reduce((s, m) => s + m.ownershipPct, 0);
  if (total > 100.01) return { error: `ownership exceeds 100% (${total.toFixed(2)}%)` };
  return { members };
}

async function replaceMembers(llcId, members) {
  await db.query(`DELETE FROM llc_members WHERE llc_id=$1`, [llcId]);
  for (const m of members) {
    await db.query(
      `INSERT INTO llc_members (llc_id, full_name, ownership_pct, email, phone) VALUES ($1,$2,$3,$4,$5)`,
      [llcId, m.fullName, m.ownershipPct, m.email, m.phone]);
  }
}

// Normalize an EIN to XX-XXXXXXX. Returns {ein} (null for blank) or {error}.
function normalizeEin(raw) {
  if (raw === undefined) return { ein: undefined };
  const s = String(raw || '').trim();
  if (!s) return { ein: null };
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length !== 9 || !/^\d{2}-?\d{7}$/.test(s.replace(/\s/g, '')))
    return { error: 'EIN must be 9 digits (XX-XXXXXXX)' };
  return { ein: `${digits.slice(0, 2)}-${digits.slice(2)}` };
}

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
  const r = await db.query(
    `INSERT INTO llcs (borrower_id,llc_name,ein,formation_state,formation_date,ownership_pct)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [me(req), b.llcName, ein.ein || null, b.formationState || null, b.formationDate || null, b.ownershipPct || null]);
  if (parsed.members && parsed.members.length) await replaceMembers(r.rows[0].id, parsed.members);
  // Requesting an LLC pulls its document requirements: EIN letter, formation docs, operating agreement.
  try { await generateLlcChecklist(r.rows[0].id); } catch (_) {}
  res.status(201).json({ ok: true, llcId: r.rows[0].id });
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
  await replaceMembers(req.params.id, parsed.members || []);
  await audit(req, 'update_llc_members', 'llc', req.params.id, { count: (parsed.members || []).length });
  res.json({ ok: true });
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
    `SELECT id, llc_id, status FROM applications
      WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2) AND deleted_at IS NULL`,
    [req.params.id, me(req)]);
  if (!app.rows[0]) return res.status(404).json({ error: 'not found' });
  if (['funded', 'declined', 'withdrawn'].includes(app.rows[0].status))
    return res.status(409).json({ error: 'this file is closed — the vesting entity can no longer be changed' });
  const own = await db.query(`SELECT id FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'llc not found' });
  const previous = app.rows[0].llc_id;
  await db.query(`UPDATE applications SET llc_id=$2, updated_at=now() WHERE id=$1`, [req.params.id, b.llcId]);
  try { await generateLlcChecklist(b.llcId); } catch (_) { /* best-effort */ }
  // reopen + appId: the previous entity's state no longer drives this file's
  // LLC condition — recompute it from the NEWLY linked entity, even downgrading
  // an auto-satisfied item left behind by the old link.
  try { await llcLib.syncLlcConditions(b.llcId, { appId: req.params.id, reopen: true }); } catch (_) { /* best-effort */ }
  await audit(req, 'link_llc', 'application', req.params.id, { llcId: b.llcId, previous });
  res.json({ ok: true });
});

// ---------------- APPRAISAL PAYMENT CARD (a borrower condition) ----------------
// The borrower enters the card the appraisal is ordered on. Stored encrypted
// (AES-256-GCM, same key handling as SSNs); the back office decrypts it when
// placing the order. Luhn + expiry validated server-side.
function luhnOk(num) {
  const s = String(num || '').replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
function cardBrand(num) {
  const s = String(num || '').replace(/\D/g, '');
  if (/^4/.test(s)) return 'Visa';
  if (/^(5[1-5]|2[2-7])/.test(s)) return 'Mastercard';
  if (/^3[47]/.test(s)) return 'Amex';
  if (/^6(011|5)/.test(s)) return 'Discover';
  return 'Card';
}
router.post('/applications/:id/appraisal-card', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const number = String(b.number || '').replace(/\D/g, '');
  if (!luhnOk(number)) return res.status(400).json({ error: 'That does not look like a valid card number — please check the digits.' });
  const expMonth = parseInt(b.expMonth, 10), expYear = parseInt(b.expYear, 10);
  const fullYear = expYear < 100 ? 2000 + expYear : expYear;
  if (!(expMonth >= 1 && expMonth <= 12)) return res.status(400).json({ error: 'expiration month must be 1–12' });
  const now = new Date();
  if (!(fullYear > now.getFullYear() || (fullYear === now.getFullYear() && expMonth >= now.getMonth() + 1)))
    return res.status(400).json({ error: 'that card is expired' });
  const cvc = String(b.cvc || '').replace(/\D/g, '');
  if (cvc.length < 3 || cvc.length > 4) return res.status(400).json({ error: 'security code must be 3 or 4 digits' });
  const zip = String(b.zip || '').trim().slice(0, 10);
  if (!zip) return res.status(400).json({ error: 'billing ZIP is required' });
  try {
  // encryptSSN yields binary (bytea shape) — base64 it for the text column.
  const enc = C.encryptSSN(JSON.stringify({ number, cvc })).toString('base64');
  await db.query(
    `INSERT INTO application_payment_cards (application_id,borrower_id,card_encrypted,last4,brand,exp_month,exp_year,billing_zip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (application_id) DO UPDATE SET
       card_encrypted=EXCLUDED.card_encrypted, last4=EXCLUDED.last4, brand=EXCLUDED.brand,
       exp_month=EXCLUDED.exp_month, exp_year=EXCLUDED.exp_year, billing_zip=EXCLUDED.billing_zip,
       borrower_id=EXCLUDED.borrower_id, updated_at=now()`,
    [req.params.id, me(req), enc, number.slice(-4), cardBrand(number), expMonth, fullYear, zip]);
  await db.query(
    `UPDATE checklist_items SET status='received', updated_at=now()
      WHERE application_id=$1 AND tool_key='appraisal_card'`, [req.params.id]);
  await audit(req, 'save_appraisal_card', 'application', req.params.id, { last4: number.slice(-4) });
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, a.ys_loan_number, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
    const row = a.rows[0];
    if (row) {
      const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
      for (const sid of new Set([row.loan_officer_id, row.processor_id].filter(Boolean)))
        await notify.notifyStaff(sid, {
          type: 'condition_added', title: `${who} added the appraisal card`,
          body: `${row.ys_loan_number || 'A file'} — ${cardBrand(number)} ending ${number.slice(-4)}. The appraisal can be ordered.`,
          applicationId: req.params.id, link: `/internal/app/${req.params.id}` });
    }
  } catch (_) { /* best-effort */ }
  res.status(201).json({ ok: true, last4: number.slice(-4), brand: cardBrand(number) });
  } catch (e) { res.status(500).json({ error: db.describeError(e) }); }
});
// Masked view for the borrower's own condition row.
router.get('/applications/:id/appraisal-card', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT last4, brand, exp_month, exp_year, billing_zip, updated_at
       FROM application_payment_cards WHERE application_id=$1`, [req.params.id]);
  res.json(r.rows[0] || null);
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

// ---------------- TRACK RECORDS (general per-borrower section) ----------------
// A borrower's track record is one general dataset — never tied to a single
// file. Loan-file experience conditions link here automatically.
router.get('/track-records', async (req, res) => {
  const r = await db.query(
    `SELECT t.*, COALESCE(t.entity_name, l.llc_name) AS entity_name,
            (SELECT count(*)::int FROM documents d WHERE d.track_record_id=t.id) AS doc_count
       FROM track_records t
       LEFT JOIN llcs l ON l.id = t.llc_id
      WHERE t.borrower_id=$1 ORDER BY t.sale_date DESC NULLS LAST, t.created_at DESC`, [me(req)]);
  res.json(r.rows);
});
// Shared field validation + column mapping for create/update. Mirrors the
// static Track Record tool's rules: a flip needs a sale; a hold needs a
// lease-up or refinance exit; ground-up needs any exit.
function trackRecordErrors(b) {
  const dealType = b.dealType || 'flip';
  const typeText = String(dealType).toLowerCase();
  const addressText = b.propertyAddress && (b.propertyAddress.oneLine || b.propertyAddress.street || b.propertyAddress.line1);
  if (!addressText) return 'property address is required';
  if (!moneyField(b.purchasePrice)) return 'purchase price is required';
  if (!b.purchaseDate) return 'purchase date is required';
  if (!moneyField(b.rehabAmount)) return 'rehab budget is required';
  const isHold = typeText.indexOf('hold') >= 0 || typeText.indexOf('rental') >= 0;
  const isGround = typeText.indexOf('ground') >= 0;
  if (!isHold && !isGround && (!moneyField(b.salePrice) || !b.saleDate)) {
    return 'sale price and sale date are required for a fix-and-flip deal';
  }
  if (isHold && (!moneyField(b.rentAmount) && !moneyField(b.refiAmount))) {
    return 'monthly rent or refinance amount is required for a fix-and-hold deal';
  }
  if (isHold && (!b.rentDate && !b.refiDate)) {
    return 'rent date or refinance date is required for a fix-and-hold deal';
  }
  if (isGround && !((moneyField(b.salePrice) && b.saleDate) || (moneyField(b.rentAmount) && b.rentDate) || (moneyField(b.refiAmount) && b.refiDate))) {
    return 'ground-up experience needs a sale, rent, or refinance exit';
  }
  return null;
}
function trackRecordCols(b) {
  return {
    property_address: JSON.stringify(b.propertyAddress),
    deal_type: b.dealType || 'flip',
    purchase_price: moneyField(b.purchasePrice),
    sale_price: moneyField(b.salePrice),
    rehab_amount: moneyField(b.rehabAmount),
    purchase_date: b.purchaseDate || null,
    sale_date: b.saleDate || null,
    rent_amount: moneyField(b.rentAmount),
    rent_date: b.rentDate || null,
    refi_amount: moneyField(b.refiAmount),
    refi_date: b.refiDate || null,
    current_value: moneyField(b.currentValue),
    notes: b.notes ? String(b.notes).slice(0, 1000) : null,
    property_type: b.propertyType ? String(b.propertyType).slice(0, 60) : null,
    entity_name: b.entityName ? String(b.entityName).slice(0, 160) : null,
  };
}
router.post('/track-records', async (req, res) => {
  const b = req.body || {};
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
  const r = await db.query(
    `INSERT INTO track_records (borrower_id,llc_id,${names.join(',')})
     VALUES ($1,$2,${names.map((_, i) => '$' + (i + 3)).join(',')}) RETURNING id`,
    [me(req), b.llcId || null, ...vals]);
  try { await syncExperienceChecklistForBorrower(me(req)); } catch (_) { /* best-effort */ }
  res.status(201).json({ ok: true, trackRecordId: r.rows[0].id });
});
// Edit an entry — only the borrower's own, and only while it is unverified
// (a verified entry is locked as underwriting evidence).
router.put('/track-records/:id', async (req, res) => {
  const b = req.body || {};
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
  res.json({ ok: true });
});
// Delete a track-record entry — only the borrower's own, and only while it is
// still unverified (a verified entry is locked as underwriting evidence).
router.delete('/track-records/:id', async (req, res) => {
  const r = await db.query(
    `DELETE FROM track_records WHERE id=$1 AND borrower_id=$2 AND is_verified=false RETURNING id`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found or already verified' });
  try { await syncExperienceChecklistForBorrower(me(req)); } catch (_) { /* best-effort */ }
  res.json({ ok: true });
});
// Supporting documents on ONE track-record entry (closing statement, deed,
// lease…) — what staff verify against.
router.get('/track-records/:id/documents', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM track_records WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,created_at FROM documents
      WHERE track_record_id=$1 AND visibility='borrower' ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});
router.post('/track-records/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  const own = await db.query(`SELECT 1 FROM track_records WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (borrower_id,track_record_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'borrower',$1,'track_record_doc') RETURNING id`,
    [me(req), req.params.id, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref]);
  await db.query(`UPDATE track_records SET docs_status='received', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [req.params.id]);
  await audit(req, 'upload_track_record_doc', 'track_record', req.params.id, { filename: b.filename });
  res.status(201).json({ ok: true, documentId: r.rows[0].id });
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
    const o = await db.query(`SELECT is_verified, llc_name FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'llc not found' });
    // A verified LLC's document set is locked — staff verified it as-is.
    if (o.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — ask your loan team to unlock it before replacing documents' });
  }
  // The checklist item must be the borrower's own too — otherwise the document
  // row can be pointed at another borrower's checklist-item id.
  if (b.checklistItemId) {
    const o = await db.query(
      `SELECT ci.llc_id FROM checklist_items ci
        WHERE ci.id=$1 AND (ci.borrower_id=$2
           OR ci.application_id IN (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2)
           OR ci.llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`,
      [b.checklistItemId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'checklist item not found' });
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
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  // Optional kind tag. 'term_sheet' marks the registered-product term sheet
  // PDF captured from the Term Sheet Studio: each re-registration supersedes
  // the previous term sheet so exactly one is current on the file.
  const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;
  // Optional slot: a condition holds several coexisting documents, each in its
  // own named slot. Re-uploading a slot supersedes only that slot's versions.
  const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (checklist_item_id,application_id,borrower_id,llc_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrower',$10,$11,$12) RETURNING id`,
    [b.checklistItemId || null, b.applicationId || null, me(req), b.llcId || null,
     b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, me(req), docKind, slot]);
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
    // condition's other documents coexist.
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
          AND ($4::text IS NOT NULL OR $5::uuid IS NULL)
          AND ($4::text IS NULL OR slot_label IS NOT DISTINCT FROM $4)`,
      [b.checklistItemId, me(req), r.rows[0].id, slot, b.replaceDocumentId || null]);
    await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1 AND (application_id IN (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2) OR borrower_id=$2 OR llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`, [b.checklistItemId, me(req)]);
  }
  // An LLC document changed — recompute the LLC condition on every open file
  // vesting in this entity (all three in => the condition moves to review).
  if (b.llcId) { try { await llcLib.syncLlcConditions(b.llcId); } catch (_) { /* best-effort */ } }
  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename });
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
          `SELECT id, loan_officer_id, processor_id FROM applications
            WHERE llc_id=$1 AND deleted_at IS NULL
              AND status NOT IN ('funded','declined','withdrawn')`, [b.llcId]);
        const targets = new Set();
        for (const a of apps.rows) { if (a.loan_officer_id) targets.add(a.loan_officer_id); if (a.processor_id) targets.add(a.processor_id); }
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
        let where = '';
        if (b.checklistItemId) {
          const it = await db.query(`SELECT label FROM checklist_items WHERE id=$1`, [b.checklistItemId]);
          if (it.rows[0]) where = ` to condition "${it.rows[0].label}"${slot ? ` — ${slot}` : ''}`;
        } else if (slot) where = ` — ${slot}`;
        const opts = {
          type: 'doc_uploaded',
          title: 'New document uploaded',
          body: `${who} uploaded "${b.filename}"${where}.`,
          applicationId: b.applicationId,
          link: `/internal/app/${b.applicationId}`,
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
    `SELECT id,filename,content_type,size_bytes,application_id,llc_id,checklist_item_id,slot_label,doc_kind,created_at,
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
// co-borrow, plus the vesting LLC's documents on a file they co-borrow.
// visibility='borrower' is mandatory — a borrower must never be able
// to fetch a staff-only / internal document even with a guessed id.
router.get('/documents/:id/download', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,storage_ref FROM documents
      WHERE id=$1 AND visibility='borrower' AND (borrower_id=$2 OR application_id IN
        (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2)
        OR (llc_id IS NOT NULL AND llc_id IN
          (SELECT llc_id FROM applications WHERE (borrower_id=$2 OR co_borrower_id=$2) AND llc_id IS NOT NULL)))`,
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
      ORDER BY m.created_at DESC LIMIT 500`,
    [me(req), req.query.applicationId || null]);
  r.rows.reverse();   // newest-500 window, still rendered oldest-first
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
          link: `/internal/app/${b.applicationId}`, ctaLabel: 'Open the conversation',
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
    [borrowerId, p.cellPhone || '', p.dateOfBirth || '', p.citizenship || '', p.maritalStatus || '',
     p.fico ? parseInt(p.fico, 10) || null : null,
     currentAddress, isFinite(yearsAtResidence) ? yearsAtResidence : null,
     monthsAtResidence, p.housingStatus || '', housingPayment]);
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
  // A typed-but-never-picked entity name still links a real profile LLC.
  if (!b.llcId && b.entityName) { try { b.llcId = await resolveEntityByName(me(req), b.entityName); } catch (_) { /* best-effort */ } }

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
        rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
        is_assignment,underlying_contract_price,assignment_fee,
        term,requested_ir_months,
        requested_exp_reo,payoff_amount,original_purchase_price,acquisition_date,
        source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$24,$25,$26,$27,$28,$29,'portal',$23,'new',now())
     RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, officerId, b.loanOfficerName || null,
     b.rehabType || null, intField(b.sqftPre) || null, intField(b.sqftPost) || null,
     intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
     !!b.isAssignment, b.underlyingContractPrice || null, b.assignmentFee || null, JSON.stringify(redactPII(b)),
     b.termMonths ? String(b.termMonths) : null, intField(b.irMonths),
     intField(b.requestedExpReo), moneyField(b.payoffAmount), moneyField(b.originalPurchasePrice), b.acquisitionDate || null]);
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
        applicationId: appId, link: `/internal/app/${appId}`, meta,
        emailTo: officerRow.email, ctaLabel: 'Open the loan file',
      });
    } else {
      await notify.notifyAdmins({
        type: 'unassigned_application', title: 'New application — Lead Capture',
        body: 'A borrower submitted a new application with no loan officer selected. It is in Lead Capture.',
        applicationId: appId, link: `/internal`, meta, ctaLabel: 'Open Lead Capture',
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
                'sort_order', 'tool_key', 'clickup_field_id', 'created_by_kind', 'is_required'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.borrower_label || null, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null, tpl.borrower_hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, 'system',
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
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE is_active=true AND scope IN ('application','borrower_profile')
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
module.exports.trackRecordErrors = trackRecordErrors;
module.exports.trackRecordCols = trackRecordCols;
