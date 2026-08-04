/**
 * TPO PORTAL API — the third front door (owner-directed 2026-08-04; db/464 +
 * db/465; design docs/TPO-PORTAL-BLUEPRINT.md).
 *
 * Every endpoint requires a `kind='tpo'` session (an EXTERNAL brokerage user, a
 * staff_users row flagged is_external) and is FIRM-SCOPED: a TPO user only ever
 * sees their own firm's TPO files and borrowers, never a retail file and never
 * another firm's. Firm isolation lives in ONE place —
 * `permissions.tpoFirmScopeSql` — so every query here routes through it (the
 * same single-definition discipline as the staff `visibleOfficersSql`).
 *
 * This router is deliberately SEPARATE from /api/staff and /api/borrower rather
 * than poking is_external holes into them: an external party touching a lender's
 * system gets a small, curated surface, so a staff-only capability or an
 * internal integration can never be reached by accident. Feature endpoints
 * (pricing, conditions, orders, credit, documents …) are added here in later
 * phases, each reusing the underlying lib layer with the borrower-safe filters
 * already applied.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const mail = require('../lib/email/catalog');
const fields = require('../lib/fields');
const storage = require('../lib/storage');
const { decodeUploadBase64, safeFilename } = require('../lib/upload-bytes');
const { scrubFields } = require('../lib/borrower-safe');
const { requireAuth, requireTpo } = require('../auth');
const perms = require('../lib/permissions');

// Every TPO route is gated: a valid session AND the tpo kind.
router.use(requireAuth, requireTpo);

// A TPO user IS a staff_users row, so an audited action logs as actor_kind
// 'staff' (the only allowed value that carries their id); the `via:'tpo'` detail
// marks it a broker action. Best-effort — logging must never fail an action.
async function tpoAudit(req, action, entityType, entityId, detail) {
  let d = detail; if (d != null && typeof d !== 'object') d = { note: String(d) };
  if (d && typeof d === 'object') d = { ...d, via: 'tpo' }; else d = { via: 'tpo' };
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entityType, entityId || null, req.ip, req.get('user-agent') || null, d]);
  } catch (e) { console.warn('[tpo-audit] failed', action, db.describeError ? db.describeError(e) : (e && e.message)); }
}

// THE firm-scope guards — is this borrower / file inside the acting broker's
// firm? Both route through the single isolation definition in permissions.js, so
// a stray id (a retail borrower, another firm's file) resolves to zero rows.
async function borrowerInFirm(actorId, borrowerId) {
  if (!borrowerId) return false;
  const r = await db.query(
    `SELECT 1 FROM borrowers b WHERE b.id=$2 AND ${perms.tpoBorrowerScopeSql('b', '$1')}`,
    [actorId, borrowerId]);
  return r.rows.length > 0;
}
async function appInFirm(actorId, appId) {
  if (!appId) return false;
  const r = await db.query(
    `SELECT 1 FROM applications a WHERE a.id=$2 AND a.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}`,
    [actorId, appId]);
  return r.rows.length > 0;
}

// Who am I + which firm do I belong to. (Mirrors /auth/me's tpo branch so the
// SPA can read it from the portal API without a second auth surface.)
router.get('/me', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.is_firm_admin,
              u.tpo_firm_id, f.name AS firm_name, f.status AS firm_status
         FROM staff_users u LEFT JOIN tpo_firms f ON f.id = u.tpo_firm_id
        WHERE u.id=$1`, [req.actor.id]);
    const row = r.rows[0] || {};
    res.json({
      id: row.id, email: row.email, full_name: row.full_name, role: row.role,
      is_firm_admin: row.is_firm_admin,
      firm: row.tpo_firm_id ? { id: row.tpo_firm_id, name: row.firm_name, status: row.firm_status } : null,
    });
  } catch (e) { next(e); }
});

// The firm's pipeline — every TPO file the broker's firm has brought us, and
// ONLY those. Scoped through the single firm-isolation definition.
router.get('/applications', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.status, a.property_address,
              a.borrower_portal_enabled, a.created_at,
              NULLIF(b.full_name,'') AS borrower_name
         FROM applications a
         LEFT JOIN borrowers b ON b.id = a.borrower_id
        WHERE a.deleted_at IS NULL
          AND ${perms.tpoFirmScopeSql('a', '$1')}
        ORDER BY a.created_at DESC
        LIMIT 500`, [req.actor.id]);
    res.json({ applications: r.rows });
  } catch (e) { next(e); }
});

// ---------------- the firm's own team ----------------
// The broker's firm roster (every external user on their firm).
router.get('/team', async (req, res, next) => {
  try {
    const me = await db.query(`SELECT tpo_firm_id FROM staff_users WHERE id=$1`, [req.actor.id]);
    const firmId = me.rows[0] && me.rows[0].tpo_firm_id;
    if (!firmId) return res.json({ team: [] });
    const r = await db.query(
      `SELECT id, full_name, email, role, is_firm_admin, is_active,
              (password_hash IS NOT NULL) AS has_login
         FROM staff_users WHERE tpo_firm_id=$1 AND is_external=true
        ORDER BY is_firm_admin DESC, full_name`, [firmId]);
    res.json({ team: r.rows });
  } catch (e) { next(e); }
});

// A FIRM ADMIN invites a processor (or officer) to THEIR OWN firm. The firm is
// always the inviter's own firm — never client-supplied — and a firm admin can
// never mint another firm admin (that stays an internal-admin decision).
router.post('/team/invite', async (req, res, next) => {
  try {
    const me = (await db.query(`SELECT tpo_firm_id, is_firm_admin FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    if (!me.is_firm_admin) return res.status(403).json({ error: 'only a firm admin can invite team members' });
    const firmId = me.tpo_firm_id;
    const f = (await db.query(`SELECT status, name FROM tpo_firms WHERE id=$1`, [firmId])).rows[0];
    if (!f || f.status !== 'active') return res.status(400).json({ error: 'the firm is not active' });
    const b = req.body || {};
    const email = String(b.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email required' });
    const role = perms.TPO_ROLE_KEYS.includes(b.role) ? b.role : 'tpo_processor';
    // Refuse an email already attached to any account. An internal staffer is
    // never convertible; an existing broker (this firm's or another's) must not
    // be re-invited — a firm admin invites NEW people only. Re-inviting a
    // same-firm colleague would demote them (this path mints is_firm_admin=false,
    // and the accept branch would apply it); a different firm's broker is not
    // theirs to touch. Either case is handled from the internal admin surface.
    const ex = await db.query(`SELECT is_external FROM staff_users WHERE lower(email)=lower($1)`, [email]);
    if (ex.rows[0] && ex.rows[0].is_external === false)
      return res.status(409).json({ error: 'that email already belongs to an internal staff account' });
    if (ex.rows[0] && ex.rows[0].is_external === true)
      return res.status(409).json({ error: 'that person already has a broker account — ask YS Capital to move or update them' });
    const token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash, kind, email, role, created_by, tpo_firm_id, is_firm_admin, expires_at)
       VALUES ($1,'tpo',$2,$3,$4,$5,false, now() + interval '7 days')`,
      [C.sha256(token), email, role, req.actor.id, firmId]);
    const acceptUrl = mail.link('/tpo/accept?token=' + token);
    let emailed = false;
    try {
      const r = await mail.send('tpoInvite', email, { fullName: b.fullName || '', firmName: f.name, role, acceptUrl, days: 7 });
      emailed = !!(r && r.ok);
    } catch (_) { /* best-effort */ }
    res.status(201).json({ ok: true, token, acceptUrl, emailed });
  } catch (e) { next(e); }
});

// ============================================================================
// PHASE 3 — the firm's BORROWERS (with full PII) + entering loans.
// A TPO user gets everything a borrower can do PLUS the borrower's PII, but ONLY
// for their own firm's borrowers. Every read/write is firm-scoped through the
// ONE isolation definition; a retail borrower or another firm's borrower is
// structurally unreachable.
// ============================================================================

// The firm's borrower book — everyone who is the borrower/co-borrower on one of
// the firm's TPO files, and only those.
router.get('/borrowers', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT b.id, NULLIF(b.full_name,'') AS full_name, b.email, b.cell_phone,
              b.ssn_last4, (b.ssn_encrypted IS NOT NULL) AS has_ssn,
              (SELECT count(*)::int FROM applications a
                 WHERE (a.borrower_id=b.id OR a.co_borrower_id=b.id)
                   AND a.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}) AS file_count
         FROM borrowers b
        WHERE ${perms.tpoBorrowerScopeSql('b', '$1')}
        ORDER BY b.full_name NULLS LAST
        LIMIT 500`, [req.actor.id]);
    res.json({ borrowers: r.rows });
  } catch (e) { next(e); }
});

// A borrower's full profile (PII) — firm-scoped. The SSN itself is revealed only
// through the dedicated, audited /ssn endpoint below; here we return only the
// last-4 + a has-ssn flag.
router.get('/borrowers/:id', async (req, res, next) => {
  try {
    if (!(await borrowerInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'borrower not found' });
    const r = await db.query(
      `SELECT id, first_name, last_name, middle_name, name_suffix, NULLIF(full_name,'') AS full_name,
              email, cell_phone, date_of_birth, current_address, prior_address, citizenship,
              marital_status, dependents_count, employment_type, employer, fico,
              ssn_last4, (ssn_encrypted IS NOT NULL) AS has_ssn, created_at
         FROM borrowers WHERE id=$1`, [req.params.id]);
    res.json({ borrower: r.rows[0] || null });
  } catch (e) { next(e); }
});

// Reveal the full SSN (XXX-XX-XXXX) — audited, firm-scoped.
router.get('/borrowers/:id/ssn', async (req, res, next) => {
  try {
    if (!(await borrowerInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'borrower not found' });
    const r = await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [req.params.id]);
    if (!r.rows[0] || !r.rows[0].ssn_encrypted) return res.status(404).json({ error: 'no ssn on file' });
    await tpoAudit(req, 'view_ssn', 'borrower', req.params.id);
    res.json({ ssn: fields.formatSsn(C.decryptSSN(r.rows[0].ssn_encrypted)) });
  } catch (e) { next(e); }
});

// Set the SSN — audited. A clash with ANY other profile is refused GENERICALLY:
// a broker must never learn about, or be able to move a number off, a profile
// outside their firm (a retail borrower, another firm's borrower, or a
// duplicate). Cross-profile resolution stays an internal-staff action.
router.post('/borrowers/:id/ssn', async (req, res, next) => {
  try {
    if (!(await borrowerInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'borrower not found' });
    const store = C.ssnForStorage((req.body || {}).ssn);
    if (!store) return res.status(400).json({ error: 'a full 9-digit Social Security number is required' });
    const hash = require('../clickup/identity').ssnHash(store.digits, cfg.ssnMatchKey);
    const clash = (await db.query(`SELECT 1 FROM borrowers WHERE ssn_hash=$1 AND id<>$2 LIMIT 1`, [hash, req.params.id])).rows[0];
    if (clash) return res.status(409).json({ error: 'This Social Security number is already on file. Contact YS Capital if you think this is a mistake.' });
    const before = (await db.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'borrower not found' });
    await db.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=$4, updated_at=now() WHERE id=$1`,
      [req.params.id, store.encrypted, store.last4, hash]);
    await tpoAudit(req, 'set_borrower_ssn', 'borrower', req.params.id, { beforeLast4: before.ssn_last4 || null, afterLast4: store.last4 });
    res.json({ ok: true, last4: store.last4 });
  } catch (e) { next(e); }
});

// Edit a borrower's profile fields — firm-scoped. A whitelist of borrower-safe
// PII; every value goes through the shared column sanitizers (the same bounds
// the staff doors enforce). Email is deliberately NOT editable here (changing it
// risks a uniqueness collision with a profile outside the firm) — it is set at
// loan entry. The SSN has its own audited door above.
const BORROWER_TEXT_COLS = {
  firstName: 'first_name', lastName: 'last_name', middleName: 'middle_name',
  nameSuffix: 'name_suffix', cellPhone: 'cell_phone', citizenship: 'citizenship',
  maritalStatus: 'marital_status', employmentType: 'employment_type', employer: 'employer',
};
router.patch('/borrowers/:id', async (req, res, next) => {
  try {
    if (!(await borrowerInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'borrower not found' });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    for (const [key, col] of Object.entries(BORROWER_TEXT_COLS)) {
      if (b[key] !== undefined) put(col, fields.textColumn(b[key], col));
    }
    if (b.dateOfBirth !== undefined) {
      const problem = b.dateOfBirth ? fields.dobProblem(b.dateOfBirth) : null;
      if (problem) return res.status(400).json({ error: problem });
      put('date_of_birth', b.dateOfBirth ? fields.sanitizeDob(b.dateOfBirth) : null);
    }
    if (b.fico !== undefined) {
      const f = b.fico === '' || b.fico === null ? null : fields.sanitizeFico(b.fico);
      if (b.fico !== '' && b.fico !== null && f === null) return res.status(400).json({ error: 'credit score must be a number between 300 and 850' });
      put('fico', f);
    }
    if (b.currentAddress !== undefined) put('current_address', b.currentAddress ? fields.jsonbText(b.currentAddress) : null);
    if (b.dependentsCount !== undefined) put('dependents_count', b.dependentsCount === '' || b.dependentsCount === null ? null : Math.trunc(Number(b.dependentsCount)) || null);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    await db.query(`UPDATE borrowers SET ${sets.join(', ')}, updated_at=now() WHERE id=$${vals.length}`, vals);
    await tpoAudit(req, 'tpo_edit_borrower', 'borrower', req.params.id, { fields: Object.keys(b).filter((k) => BORROWER_TEXT_COLS[k] || ['dateOfBirth', 'fico', 'currentAddress', 'dependentsCount'].includes(k)) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// A single TPO file (firm-scoped). Borrower-safe fields only — NO note buyer /
// capital partner, no internal contacts, no internal pricing margin.
router.get('/applications/:id', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.status, a.property_address, a.property_type, a.units,
              a.program, a.loan_type, a.rehab_type, a.purchase_price, a.as_is_value, a.arv,
              a.rehab_budget, a.loan_amount, a.is_assignment, a.borrower_portal_enabled, a.created_at,
              b.id AS borrower_id, NULLIF(b.full_name,'') AS borrower_name, b.email AS borrower_email
         FROM applications a LEFT JOIN borrowers b ON b.id=a.borrower_id
        WHERE a.id=$2 AND a.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}`,
      [req.actor.id, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'file not found' });
    res.json({ application: r.rows[0] });
  } catch (e) { next(e); }
});

// ENTER A LOAN — the origination entry point. Creates (or reuses the firm's own)
// borrower and a TPO-stamped application. Borrower resolution is SAFE: it never
// adopts a profile outside the firm. A picked borrowerId must already be in the
// firm's book; otherwise a fresh borrower row is created, and if the email is
// already owned by another profile the new row is shares_email=true (a DISTINCT
// profile) so the broker can never attach to — and read the PII of — a retail or
// other-firm borrower who happens to share the address.
router.post('/applications', async (req, res, next) => {
  try {
    const me = (await db.query(`SELECT tpo_firm_id, full_name FROM staff_users WHERE id=$1 AND is_external=true`, [req.actor.id])).rows[0] || {};
    const firmId = me.tpo_firm_id;
    if (!firmId) return res.status(403).json({ error: 'no firm on your account' });
    const f = (await db.query(`SELECT status, name FROM tpo_firms WHERE id=$1`, [firmId])).rows[0];
    if (!f || f.status !== 'active') return res.status(400).json({ error: 'your firm is not active' });

    const b = req.body || {};
    const bo = b.borrower || {};
    const email = String(bo.email || '').trim();
    const firstName = String(bo.firstName || '').trim();
    const lastName = String(bo.lastName || '').trim();
    const addr = b.propertyAddress || null;
    if (!firstName) return res.status(400).json({ error: 'borrower first name required' });
    if (!email) return res.status(400).json({ error: 'borrower email required' });
    if (!addr || !(addr.oneLine || addr.street || addr.line1)) return res.status(400).json({ error: 'property address required' });
    { const numProblem = fields.applicationNumberProblem(b); if (numProblem) return res.status(400).json({ error: numProblem }); }
    // Refuse an appraisal FORM code masquerading as a property type (the same
    // guard every other write door runs — property-type.js).
    { const ptProblem = require('../lib/property-type').propertyTypeProblem(b.propertyType); if (ptProblem) return res.status(400).json({ error: ptProblem }); }

    // ---- SAFE borrower resolution ----
    let borrowerId;
    if (b.borrowerId) {
      if (!(await borrowerInFirm(req.actor.id, b.borrowerId))) return res.status(404).json({ error: 'that borrower is not in your book' });
      borrowerId = b.borrowerId;
      if (bo.phone) await db.query(`UPDATE borrowers SET cell_phone=COALESCE(cell_phone,$2), updated_at=now() WHERE id=$1`, [borrowerId, fields.textColumn(bo.phone, 'cell_phone')]);
    } else {
      const owned = (await db.query(`SELECT 1 FROM borrowers WHERE email=$1 AND shares_email=false LIMIT 1`, [email])).rows[0];
      const ins = await db.query(
        `INSERT INTO borrowers (first_name,last_name,email,cell_phone,shares_email,origin)
         VALUES ($1,$2,$3,$4,$5,'tpo') RETURNING id`,
        [firstName, lastName || '', email, fields.textColumn(bo.phone, 'cell_phone'), !!owned]);
      borrowerId = ins.rows[0].id;
    }

    // ---- TPO-stamped application ----
    const { isAssignment, underlying, assignFee, purchasePrice } = fields.assignmentFields(b);
    const money = fields.moneyColumn;
    // A refinance is sized on the as-is value and carries NO purchase price
    // (deal-basis invariant, db/399) — never store one on a refi.
    const isRefi = require('../lib/deal-basis').sizesOnAsIsValue(b.loanType);
    const ppFinal = isRefi ? null : purchasePrice;
    const portalOn = b.borrowerPortalEnabled === false ? false : true;
    const ins = await db.query(
      `INSERT INTO applications
         (borrower_id, property_address, property_type, units, program, loan_type,
          purchase_price, as_is_value, arv, rehab_budget, loan_officer_id, loan_officer_name,
          rehab_type, is_assignment, underlying_contract_price, assignment_fee,
          is_tpo, tpo_firm_id, borrower_portal_enabled, source, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18,'tpo','file_intake',now())
       RETURNING id, ys_loan_number`,
      [borrowerId, fields.jsonbText(addr), b.propertyType || null, b.units || null,
       b.program || null, fields.sanitizeLoanType(b.loanType), ppFinal, money(b.asIsValue),
       money(b.arv), money(b.rehabBudget), req.actor.id, me.full_name || null,
       b.rehabType || null, isAssignment, underlying, assignFee, firmId, portalOn]);
    const appId = ins.rows[0].id;

    try { await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'tpo_create' }); }
    catch (e) { console.error('[tpo-origination] checklist failed:', db.describeError(e)); }

    await tpoAudit(req, 'tpo_create_application', 'application', appId, { firmId, borrowerId });
    res.status(201).json({ id: appId, ys_loan_number: ins.rows[0].ys_loan_number });
  } catch (e) { next(e); }
});

// The borrower-login toggle (owner-locked decision #1: the borrower keeps their
// own PILOT login BY DEFAULT; the broker may turn it OFF per file). Firm-scoped.
// The borrower side enforces it: a portal-disabled TPO file is hidden from the
// borrower's own portal (see routes/borrower.js).
router.post('/applications/:id/borrower-portal', async (req, res, next) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    const enabled = (req.body || {}).enabled !== false;
    await db.query(`UPDATE applications SET borrower_portal_enabled=$2, updated_at=now() WHERE id=$1`, [req.params.id, enabled]);
    await tpoAudit(req, 'tpo_set_borrower_portal', 'application', req.params.id, { enabled });
    res.json({ ok: true, borrower_portal_enabled: enabled });
  } catch (e) { next(e); }
});

// ============================================================================
// PHASE 4 — the file's CONDITIONS (what we need) + DOCUMENTS (provide them).
// A broker sees the BORROWER-SAFE condition set (audience borrower/both, the
// borrower_label wording, capital-partner names scrubbed) — never an internal
// condition or the internal note. They upload documents against those
// conditions; the LENDER still reviews and signs off (a broker never signs off,
// clears, or waives — those stay staff-only).
// ============================================================================

// The file's conditions — borrower-safe wording only. Mirrors the borrower
// checklist (audience borrower/both), firm-scoped. NOTE: revealing the staff-only
// order conditions (flood cert / credit / appraisal received) is a later step —
// those templates carry NO borrower_label today, so the "no safe wording → hide"
// rule keeps them out; adding safe wording is a deliberate migration.
router.get('/applications/:id/checklist', async (req, res, next) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    const r = await db.query(
      `SELECT ci.id, COALESCE(NULLIF(ci.borrower_label,''),'An item your loan team needs') AS label,
              ci.status, ci.item_kind, ci.phase, ci.borrower_hint AS hint, ci.is_required, ci.due_date,
              ci.field_key, ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted,
              -- template_code is deliberately NOT returned: a template CODE can
              -- encode a note-buyer name (e.g. cond_emd_corrfirst,
              -- cond_ssn_verify_corrfirst), and a capital-partner name must never
              -- reach an external broker surface (TPO OUT rule). The broker UI
              -- keys off status/item_kind, not the code.
              -- issue_reason is a borrower-SAFE reason; fall back to the latest
              -- rejected document's reason. ci.notes (internal) is NEVER selected.
              COALESCE(ci.issue_reason,
                (SELECT d.rejection_reason FROM documents d WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
                  ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1)) AS rejection_reason
         FROM checklist_items ci
        WHERE ci.application_id=$1 AND ci.audience IN ('borrower','both')
        ORDER BY ci.sort_order, ci.created_at`, [req.params.id]);
    const rows = r.rows.map((it) => scrubFields(it, ['label', 'hint', 'rejection_reason']));
    res.json({ checklist: rows });
  } catch (e) { next(e); }
});

// Documents on the file — the borrower-VISIBLE set only (visibility='borrower'),
// firm-scoped, capital-partner names scrubbed. Internal-only documents
// (staff_only / internal — fraud reports, internal appraisal source docs) never
// appear.
router.get('/applications/:id/documents', async (req, res, next) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    const r = await db.query(
      `SELECT id, filename, content_type, size_bytes, checklist_item_id, slot_label, doc_kind, created_at,
              review_status, rejection_reason, is_current
         FROM documents
        WHERE application_id=$1 AND visibility='borrower' AND COALESCE(source_type,'') <> 'chat_attachment'
        ORDER BY is_current DESC, created_at DESC`, [req.params.id]);
    res.json({ documents: r.rows.map((row) => scrubFields(row, ['rejection_reason', 'slot_label', 'filename'])) });
  } catch (e) { next(e); }
});

// Upload a document, optionally against a condition. Firm-scoped; the condition
// (if given) must be a BORROWER-FACING one on this file. Uploaded as the broker
// (a staff_users row, uploaded_by_kind='staff') and visible on the file
// (visibility='borrower'). New evidence clears any prior sign-off so the LENDER
// re-reviews — a broker provides, we sign off.
router.post('/documents', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
    if (!b.applicationId) return res.status(400).json({ error: 'applicationId required' });
    if (!(await appInFirm(req.actor.id, b.applicationId))) return res.status(404).json({ error: 'file not found' });
    const filename = safeFilename(b.filename);
    let itemId = null;
    if (b.checklistItemId) {
      const it = await db.query(
        `SELECT id FROM checklist_items WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both')`,
        [b.checklistItemId, b.applicationId]);
      if (!it.rows[0]) return res.status(404).json({ error: 'condition not found on this file' });
      itemId = it.rows[0].id;
    }
    let buf;
    try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
    const borrowerId = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [b.applicationId])).rows[0].borrower_id;
    // Collapse a double-submit onto the already-saved document (mirrors the borrower door).
    const dupId = await require('../lib/doc-dedup').recentDuplicateDocId({
      filename, sizeBytes: buf.length, uploadedByKind: 'staff', uploadedById: req.actor.id,
      applicationId: b.applicationId, checklistItemId: itemId, llcId: null, trackRecordId: null, slotLabel: null, docKind: null, termSheetFinal: null });
    if (dupId) return res.status(201).json({ ok: true, documentId: dupId, deduped: true });
    const { ref, provider } = await storage.save(buf, { filename });
    const r = await db.query(
      `INSERT INTO documents (checklist_item_id,application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,visibility,review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,'borrower','pending') RETURNING id`,
      [itemId, b.applicationId, borrowerId, filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id]);
    if (itemId) {
      await db.query(
        `UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE id=$1 AND audience IN ('borrower','both')`, [itemId]);
    }
    await tpoAudit(req, 'tpo_upload_document', 'document', r.rows[0].id, { applicationId: b.applicationId, checklistItemId: itemId });
    res.status(201).json({ ok: true, documentId: r.rows[0].id });
  } catch (e) { next(e); }
});

module.exports = router;
