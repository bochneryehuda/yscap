/**
 * TPO PORTAL API — the third front door (owner-directed 2026-08-04; db/472 +
 * db/473; design docs/TPO-PORTAL-BLUEPRINT.md).
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
const { scrubText, scrubFields, stripQuoteInternal, stripInputsInternal, borrowerSafeQuoteBundle } = require('../lib/borrower-safe');
const { borrowerPricingOverrides } = require('../lib/pricing-overrides');
const pricing = require('../lib/pricing');
const { RECENT_EXIT_SQL } = require('../lib/experience');
const { persistProductRegistration } = require('../lib/product-registration');
const notify = require('../lib/notify');
const termOpts = require('../lib/term-options');
const manualProgram = require('../lib/manual-program');
const conditionEngine = require('../lib/conditions/engine');
const changeRequests = require('../lib/change-requests');
const { WRITE_TARGETS, BY_KEY } = require('../lib/conditions/field-registry');
const tpoConditions = require('../lib/tpo-conditions');
const { requireAuth, requireTpo } = require('../auth');
const perms = require('../lib/permissions');

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

// Belt-and-suspenders for the untrusted external broker: scrub any capital-partner
// name out of the STRING VALUES of a stored pricing object (inputs / quote /
// term_options) before it reaches a broker. Recurses strings only — never the
// structure — so it can't corrupt a number or reshape an object. The frozen
// engines emit no partner name today (verified), so this is defense-in-depth, not
// a live leak; it costs nothing and closes the whole class if a future engine or a
// hand-edited registration ever stores one.
function scrubDeepStrings(v) {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeepStrings);
  if (v && typeof v === 'object') { const o = {}; for (const [k, val] of Object.entries(v)) o[k] = scrubDeepStrings(val); return o; }
  return v;
}

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

// Load a firm's file for pricing — the exact same {app, exp} the borrower + staff
// pricing loaders return (so the frozen engine sizes identically), but scoped
// through the ONE firm-isolation definition instead of OWN_FILE_SQL. The pricing
// FICO is the higher-of-two across the file's borrowers (#99); the experience is
// the CLAIMED-of-record (requested_exp_*), falling back to the verified
// track-record count — funding stays gated by the experience condition, so this
// never over-lends (owner-directed #85, mirrored on every pricing loader).
async function loadTpoFileForPricing(actorId, appId) {
  const a = await db.query(
    `SELECT a.*, NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
      WHERE a.id=$2 AND a.deleted_at IS NULL AND ${perms.tpoFirmScopeSql('a', '$1')}`,
    [actorId, appId]);
  const app = a.rows[0];
  if (!app) return null;
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
  const claimed = (v, fb) => (v != null ? (Number(v) || 0) : fb);
  const exp = {
    flips:  claimed(app.requested_exp_flips,  verified.flips),
    holds:  claimed(app.requested_exp_holds,  verified.holds),
    ground: claimed(app.requested_exp_ground, verified.ground),
  };
  return { app, exp };
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

// A single TPO file (firm-scoped). The BORROWER-SAFE application shape — every
// field the Term Sheet Studio prefills from (deal economics, the parties' names,
// the refinance payoff, the waiver flags, the higher-of-two pricing FICO) so the
// broker's studio opens showing what the file already knows. Deliberately absent:
// `applications.lender` (the NOTE BUYER / capital partner — staff-only) and any
// internal pricing margin. NOTE `payoff_lender` IS returned and is borrower-safe:
// it is the borrower's EXISTING loan being paid off on a refinance, never our
// capital partner.
router.get('/applications/:id', async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.status, a.property_address, a.property_type, a.units,
              a.program, a.loan_type, a.rehab_type, a.purchase_price, a.as_is_value, a.arv,
              a.rehab_budget, a.loan_amount, a.is_assignment, a.underlying_contract_price, a.assignment_fee,
              a.requested_exp_flips, a.requested_exp_holds, a.requested_exp_ground,
              a.term, a.requested_ir_months, a.requested_ir_amount,
              a.est_closing_date, a.expected_closing, a.co_borrower_pg_waived, a.liquidity_buffer_waived,
              a.payoff_amount, a.payoff_lender, a.payoff_loan_number, a.estimated_cash_out,
              a.co_borrower_id, a.borrower_portal_enabled, a.created_at,
              NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico,
              b.id AS borrower_id, NULLIF(b.full_name,'') AS borrower_name, b.email AS borrower_email,
              b.first_name, b.middle_name, b.last_name, b.name_suffix, b.full_name,
              l.llc_name AS entity_name,
              cb.first_name AS co_first_name, cb.middle_name AS co_middle_name,
              cb.last_name AS co_last_name, cb.name_suffix AS co_name_suffix, cb.full_name AS co_full_name
         FROM applications a
         LEFT JOIN borrowers b ON b.id=a.borrower_id
         LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
         LEFT JOIN llcs l ON l.id=a.llc_id
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
// PHASE 4B — the TPO Term Sheet Studio: PRICE the deal, REGISTER a product, and
// generate the term-sheet PDF. A broker prices exactly what a borrower can — the
// SAME frozen engine, the SAME borrower-safe override allowlist (no markup /
// origination / fees / manual basis), and the internal margin is stripped from
// every quote result. A broker REGISTERS a product onto their firm's file and the
// studio uploads the exact term-sheet PDF, but SENDING that package on DocuSign is
// lender-only (the `send_term_sheet` capability a TPO can never hold — Phase 4a),
// and the broker never gets a borrower "your terms are ready" email — WE send the
// official term sheet after we've reviewed it. Every read/write is firm-scoped.
// ============================================================================

// The current registration + a borrower-safe live what-if quote. Mirrors the
// borrower GET (routes/borrower.js) exactly, firm-scoped, with the internal
// margin stripped from history rows AND the live quote. `termSheetFinal` mirrors
// the STAFF response so the studio opens with the right INITIAL/FINAL wording.
router.get('/applications/:id/pricing', async (req, res, next) => {
  try {
    const f = await loadTpoFileForPricing(req.actor.id, req.params.id);
    if (!f) return res.status(404).json({ error: 'file not found' });
    const hist = await db.query(
      `SELECT r.id, r.program, r.product_label, r.status, r.note_rate, r.total_loan, r.target_ltc,
              r.is_current, r.created_at, r.inputs, r.quote, r.term_options
         FROM product_registrations r
        WHERE r.application_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    // Strip internal lender pricing (markup/spread) from anything sent to a broker
    // — a staff-created registration's quote AND inputs embed it. Never send
    // registered_by (WHICH staffer priced it is internal). The rest of `inputs` is
    // the file's own registered scenario, which the studio renders from.
    const redactRow = (row) => row ? { ...row,
      quote: scrubDeepStrings(stripQuoteInternal(row.quote)),
      inputs: scrubDeepStrings(stripInputsInternal(row.inputs)),
      term_options: scrubDeepStrings(row.term_options) } : row;
    const history = hist.rows.map(redactRow);
    const current = history.find((x) => x.is_current) || null;
    let quote = null;
    if (pricing.enginesReady()) { try { quote = borrowerSafeQuoteBundle(pricing.quoteAll(f.app, f.exp)); quote.experience = f.exp; } catch (_) {} }
    // Manual-review exception status only (never the internal summary / decision note).
    let manualEscalation = null;
    try {
      const d = await db.query(
        `SELECT status FROM manual_program_escalations
          WHERE application_id=$1 ORDER BY (status='pending') DESC, created_at DESC LIMIT 1`, [req.params.id]);
      manualEscalation = d.rows[0] || null;
    } catch (_) {}
    let termSheetHold = null;
    try { termSheetHold = await require('../lib/underwriting/appraisal-advisory').appraisalTermSheetHold(db, req.params.id); } catch (_) {}
    if (termSheetHold) termSheetHold = 'The terms are being finalized — the loan team is reviewing the appraisal. A term sheet will be available shortly.';
    let termSheetFinal = false;
    try { termSheetFinal = !!(await require('../lib/esign/term-sheet-stamp').termSheetStamp(req.params.id, { db })).final; } catch (_) { termSheetFinal = false; }
    res.json({ current, history, quote, enginesReady: pricing.enginesReady(),
      econVersion: pricing.econVersionFor(f.app), manualEscalation, termSheetHold, termSheetFinal });
  } catch (e) { console.error('[tpo pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// A live what-if quote — borrower-safe, firm-scoped. Deal economics come from the
// file; only the safe clamped knobs from the broker are honored.
router.post('/applications/:id/pricing/quote', async (req, res, next) => {
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadTpoFileForPricing(req.actor.id, req.params.id);
    if (!f) return res.status(404).json({ error: 'file not found' });
    const overrides = borrowerPricingOverrides((req.body && req.body.overrides) || {});
    const out = borrowerSafeQuoteBundle(pricing.quoteAll(f.app, f.exp, overrides));
    res.json({ ...out, experience: f.exp });
  } catch (e) { console.error('[tpo pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

// REGISTER a product onto the firm's file + let the studio attach the term-sheet
// PDF. Mirrors the borrower register (same guards, same frozen engine, same
// condition side effects) with three deliberate TPO differences:
//   1. firm-scoped, and registered_by is the BROKER (a staff_users row, a valid
//      FK) so the file records who priced it;
//   2. NO borrower "your terms are ready" email — WE send the official term sheet
//      after review; a broker register never notifies the borrower of terms;
//   3. it returns `termSheetFinal` (like the STAFF route) so the studio can stamp
//      the exact PDF FINAL/INITIAL correctly before capturing it — but sending it
//      on DocuSign stays lender-only (Phase 4a `send_term_sheet`).
router.post('/applications/:id/pricing/register', async (req, res) => {
  const appId = req.params.id;
  const b = req.body || {};
  const refuse = async (status, payload, reason, extra) => {
    try { await tpoAudit(req, 'tpo_register_product_refused', 'application', appId, { reason, ...(extra || {}) }); } catch (_) {}
    return res.status(status).json(payload);
  };
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    // A frozen/registered file (term-sheet sent, clear-to-close, funded) can't be
    // re-registered — same guard as every register door, actor-less so a broker
    // never inherits a super-admin unlock.
    const locked = await require('../lib/file-lock').structuralLockReason(appId);
    if (locked) return refuse(409, { error: locked }, 'structural_lock');
    const f = await loadTpoFileForPricing(req.actor.id, appId);
    if (!f) return res.status(404).json({ error: 'file not found' });
    // Optimistic concurrency: a stale studio session must never re-register
    // economics the file no longer has (#148).
    if (b.econVersion && b.econVersion !== pricing.econVersionFor(f.app)) {
      return refuse(409, {
        error: 'This file’s pricing inputs changed since the studio was opened. The latest values have been reloaded — review the scenario and register again.',
        code: 'econ_version_conflict',
      }, 'econ_version_conflict');
    }
    const program = b.program === 'gold' ? 'gold' : b.program === 'silver' ? 'silver' : 'standard';
    const overrides = borrowerPricingOverrides(b.overrides || {});
    // A broker never injects the claimed-experience counts on register — the
    // registered basis uses the file's experience of record (funding stays gated
    // by the experience condition). Same as the borrower door.
    delete overrides.expFlips; delete overrides.expHolds; delete overrides.expGround;
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    // Gold does not lend to an individual (owner-directed 2026-08-02) — refused on
    // top of the frozen engine, never inside it.
    {
      const vestRefusal = require('../lib/vesting-program-rule').registrationRefusal(f.app, inputs.program);
      if (vestRefusal) return res.status(400).json({ error: vestRefusal, field: 'vesting' });
    }
    // A refinance is sized on the as-is value — with none on file there is no
    // denominator and nothing to register (owner-directed 2026-08-02).
    if (inputs.asIsMissing) {
      return res.status(400).json({
        error: 'A refinance is sized on the as-is value — enter what the property is worth today before registering.',
        field: 'asIsValue' });
    }
    // Term-sheet options (display/record only). A broker registers Standard/Gold/
    // Silver only (never manual), so min-interest defaults OFF unless set.
    const rawTermOptions = (b.termOptions && typeof b.termOptions === 'object') ? b.termOptions : {};
    const closingForDates = rawTermOptions.estClosingDate || f.app.est_closing_date || f.app.expected_closing || null;
    const kd = termOpts.keyDates(closingForDates, inputs.term);
    const resolvedTermOptions = {
      accrualType: termOpts.resolveAccrual(rawTermOptions.accrualType),
      minInterestEnabled: termOpts.resolveMinInterest(program, rawTermOptions.minInterestEnabled),
      deferredOrigPct: termOpts.resolveDeferredOrigPct(rawTermOptions.deferredOrigPct),
      estClosing: kd.estClosing, firstPayment: kd.firstPayment, maturity: kd.maturity,
      coBorrowerPgWaived: !!f.app.co_borrower_pg_waived,
    };
    const quote = pricing.quoteProgram(program, inputs);
    if (program === 'gold' && quote.kind === 'reno') { inputs.irMonths = 0; inputs.irAmount = 0; }
    if (quote.status === 'INELIGIBLE') return refuse(422, { error: 'ineligible', reasons: quote.reasons, quote: stripQuoteInternal(quote) }, 'ineligible', { program });
    const total = quote.sizing ? quote.sizing.totalLoan : 0;
    if (!(total > 0)) return refuse(422, { error: 'no loan sized', quote: stripQuoteInternal(quote) }, 'no_loan_sized', { program });

    // A MANUAL result is a manual-review EXCEPTION (below the minimum, over the
    // maximum, or any other guideline exception). A broker can NEVER self-confirm
    // such terms: block the plain register and, only when they explicitly submit
    // the exception, register it pending and open a super-admin escalation. No
    // terms go out unless a super-admin approves it.
    const submitException = !!b.submitException;
    const manualReasons = (quote.reasons || [])
      .filter((r) => r && r.level === 'MANUAL').map((r) => r.msg).filter(Boolean);
    if (quote.status === 'MANUAL' && !submitException) {
      return refuse(422, {
        error: 'exception_required', code: 'exception_required',
        message: `This scenario isn’t eligible as-is on the ${pricing.PROGRAM_LABEL[program]}. It needs a manual-review exception: ${manualReasons.join('; ') || 'a guideline exception'}. Submit an exception request and the loan team will review it — no terms are sent unless it’s approved.`,
        reasons: quote.reasons, quote: stripQuoteInternal(quote),
        exceptionRequired: true, manualReasons,
      }, 'exception_required', { program });
    }
    const needsEscalation = manualProgram.needsSuperAdminApproval({ program, status: quote.status });
    {
      const storeProblem = require('../lib/product-registration').quoteStorageProblem(quote, inputs);
      if (storeProblem) return res.status(400).json({ error: storeProblem });
    }

    const client = await db.getClient();
    let regId;
    let loanAmountChanged = false;
    try {
      await client.query('BEGIN');
      const reg = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: req.actor.id,
        termOptions: resolvedTermOptions,
      });
      regId = reg.id;
      loanAmountChanged = reg.loanAmountChanged;
      if (needsEscalation) {
        await manualProgram.openEscalation(client, {
          appId, registrationId: regId, assetMonths: null, overrides: {},
          summary: {
            kind: 'manual_review', program, status: quote.status,
            totalLoan: total, noteRate: quote.noteRate,
            acqLtvPct: quote.sizing ? quote.sizing.acqLtvPct : null,
            arvPct: quote.sizing ? quote.sizing.arvPct : null,
            ltcPct: quote.sizing ? quote.sizing.ltcPct : null,
            manualReasons, requestedByTpo: true,
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

    // A typed vesting entity fills the file's LLC when it has none — fill-only,
    // best-effort (never renames an existing one).
    try {
      const typed = String((b.overrides && b.overrides.entityName) || b.entityName || '').trim();
      const cur = (await db.query(`SELECT llc_id, borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {};
      if (typed && !cur.llc_id && cur.borrower_id) {
        const vestLlcId = await require('../lib/vesting').resolveEntityByName(cur.borrower_id, typed);
        if (vestLlcId) await require('../lib/vesting').setVestingLlc(appId, vestLlcId, { source: 'tpo', actor: req.actor.id });
      }
    } catch (e) { console.error('[tpo-register] vesting from studio failed:', db.describeError(e)); }
    // Registration rewrites loan amount / rate / program — re-run condition rules,
    // sync the liquidity requirement, enforce the Gold 5% SOW contingency, and
    // clear a signed Heter Iska if the loan amount moved. Same as the borrower door.
    try { await conditionEngine.evaluateApplication(appId, { reason: 'product_registered' }); } catch (_) {}
    try { await require('../lib/liquidity').syncLiquidityCondition(appId, quote); } catch (_) {}
    try { await require('../lib/rehab-budget').enforceGoldSowContingency(appId); } catch (_) {}
    if (loanAmountChanged) {
      try {
        await require('../lib/esign/iska-autoclear').autoClearIskaOnLoanChange({
          appId, actorId: req.actor.id, db, docusign: require('../lib/integrations/docusign') });
      } catch (e) { console.warn('[tpo-register] ISKA auto-clear failed:', db.describeError(e)); }
    }
    // (Re-)registering resets the Products & pricing condition to received and
    // clears any prior sign-off — staff re-verify the new structure (mirrors the
    // db/096 trigger reopen semantics).
    try {
      await db.query(
        `UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL,
             reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE application_id=$1 AND tool_key='product_pricing'`, [appId]);
    } catch (_) { /* condition may not exist on older files */ }

    await tpoAudit(req, 'tpo_register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null });

    // Tell OUR team a broker priced the file — reaches the internally-assigned AE /
    // AM once assigned (notifyAppStaff filters out external users, so the broker is
    // never a recipient). NO borrower terms email — WE send the official sheet.
    try {
      const rate = quote.noteRate != null ? require('../lib/rate-format').fmtRatePct(quote.noteRate) + '%' : 'n/a';
      const ctx = await notify.fileContext(appId, [
        { label: 'Registered product', value: [quote.programLabel, quote.productLabel].filter(Boolean).join(' - ') || pricing.PROGRAM_LABEL[program] },
        { label: 'Total loan', value: `${money(total)} @ ${rate}` },
        quote.cashToClose != null ? { label: 'Cash to close', value: money(quote.cashToClose) } : null,
      ].filter(Boolean));
      const label = ctx ? ctx.label : appId;
      if (needsEscalation) {
        await notify.notifyAdmins({
          type: 'manual_escalation',
          title: 'Broker exception request needs approval',
          body: `A broker submitted a ${pricing.PROGRAM_LABEL[program]} exception request on ${label} (${manualReasons.join('; ') || 'guideline exception'}) — it’s waiting for approval in the Escalations box. No terms are sent unless it’s approved. Loan amount ${money(total)}.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: appId,
          link: '/internal/escalations', ctaLabel: 'Open the Escalations box',
        });
      } else {
        await notify.notifyAppStaff(appId, {
          type: 'product_registered',
          title: 'A broker registered a product',
          body: `${pricing.PROGRAM_LABEL[program]} registered by the broker on ${label}: ${money(total)} @ ${rate}.`,
          applicationId: appId, meta: (ctx && ctx.meta) || undefined,
          link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file',
        });
      }
    } catch (_) { /* notifications are best-effort */ }

    // The studio stamps the PDF FINAL/INITIAL from this — every send-gate
    // requirement met EXCEPT the Products & pricing sign-off (which is exactly this
    // step). Fails closed to INITIAL. The DocuSign SEND is still lender-only.
    let termSheetFinal = false;
    try { termSheetFinal = !!(await require('../lib/esign/term-sheet-stamp').termSheetStamp(appId, { db })).final; } catch (_) { termSheetFinal = false; }
    res.status(201).json({ ok: true, registrationId: regId, quote: stripQuoteInternal(quote), pendingApproval: needsEscalation, termSheetFinal });
    // Shadow-Excel parity monitor (owner-directed 2026-07-30): background-check a
    // registered Silver scenario against the workbook transcription — watch-only,
    // never blocks. Fired on every register surface, including the broker's.
    if (program === 'silver') {
      setImmediate(() => {
        try { require('../lib/silver-shadow-parity').monitorQuote(appId, inputs, quote).catch(() => {}); } catch (_) { /* watch-only */ }
      });
    }
  } catch (e) { console.error('[tpo pricing]', e && e.message); res.status(500).json({ error: 'server error' }); }
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
    const rows = r.rows.map((it) => {
      const s = scrubFields(it, ['label', 'hint', 'rejection_reason']);
      // A broker may ANSWER an information condition — but only for a DEAL
      // (applications) field or an admin CUSTOM field (app-scoped, not a known
      // built-in). A PERSON field (fico → the borrowers table) is edited on the
      // borrower's profile (its own governance), and a NON-WRITABLE built-in
      // (note_buyer / ltv / ys_loan_number …) can't be written from a condition
      // at all — neither is answerable, so the input never becomes a dead end.
      // The writer route + writeFieldValue enforce this too; the flag just hides
      // the input. `!BY_KEY[field]` = a custom field (not in the static registry).
      const isInfo = it.tool_key === 'info_field' && !!it.field_key;
      const wt = isInfo ? WRITE_TARGETS[it.field_key] : null;
      s.answerable = isInfo && ((wt && wt.table === 'applications') || !BY_KEY[it.field_key]);
      s.readOnly = false;
      return s;
    });
    // A small, hand-picked READ-ONLY view of the staff-driven ORDER conditions so
    // the broker can track lender progress (credit pulled? appraisal in?). Never
    // the internal label / hint / note / reason — only the fixed broker-safe
    // wording from the ONE allowlist (tpo-conditions.js), plus the raw status.
    // The flood certificate / insurance, fraud, and the review gates are NEVER on
    // this allowlist (HARD RULE), so a broker can never see one.
    const rev = await db.query(
      `SELECT ci.id, ci.status, t.code AS code
         FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND ci.audience='staff' AND t.code = ANY($2::text[])
        ORDER BY t.sort_order, ci.created_at`, [req.params.id, tpoConditions.REVEAL_CODES]);
    // ONE row per code. A co-borrower's separate credit pull creates a SECOND
    // rtl_cond_credit staff item (credit/co-condition.js, field_key='cob_credit'),
    // so the broker should see ONE "Credit report" — the LEAST-advanced status,
    // since the step isn't done until both borrowers' credit is in. The Map keeps
    // first-seen (sort_order) order; replacing a key keeps its position.
    const done = (s) => s === 'satisfied' || s === 'waived';
    const byCode = new Map();
    for (const row of rev.rows) {
      const cur = byCode.get(row.code);
      if (!cur || (done(cur.status) && !done(row.status))) byCode.set(row.code, row);
    }
    const progress = [...byCode.values()].map((row) => tpoConditions.revealRow(row.id, row.code, row.status)).filter(Boolean);
    res.json({ checklist: rows, progress });
  } catch (e) { next(e); }
});

// A broker ANSWERS an information condition — the value is written into the real
// deal (applications) field, the condition moves to 'received', and the rule
// engine re-checks the file. Firm-scoped. This is the ONLY door a broker has to
// fill a deal field (there is no TPO details-edit door), so it is genuinely
// useful — but it must be no more permissive than a borrower/staffer editing the
// same field. That guarantee is single-definition: `conditionEngine.writeFieldValue`
// validates + fits the column AND, for an applications field, applies the file
// freeze (payoffContactLockReason, called ACTOR-LESS so a broker never inherits a
// super-admin unlock) and the refinance purchase-price guard — so a broker gets
// the SAME refusal, with the same wording, on the same frozen field. A PERSON
// field (fico → borrowers) is redirected to the profile door (its own governance)
// and never written from here. No ClickUp push (a TPO file does not sync).
router.post('/applications/:id/checklist/:itemId/info', async (req, res, next) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    const it = await db.query(
      `SELECT id, field_key, borrower_label, label FROM checklist_items
        WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key='info_field'`,
      [req.params.itemId, req.params.id]);
    const item = it.rows[0];
    if (!item) return res.status(404).json({ error: 'information item not found' });
    if (!item.field_key) return res.status(400).json({ error: 'this item is not linked to a field' });
    const value = (req.body || {}).value;
    if (value === undefined || value === null || value === '') return res.status(400).json({ error: 'a value is required' });
    // A person field (fico) belongs on the borrower's profile, which has its own
    // governance (a registered file routes it to a change request). Never written
    // from a broker's condition answer.
    const target = WRITE_TARGETS[item.field_key];
    if (target && target.table === 'borrowers') {
      return res.status(400).json({ error: 'Update this on the borrower’s profile.' });
    }
    // PARITY WITH THE BORROWER (audit 2026-08-05): once a product is REGISTERED the
    // deal economics are authoritative, so a change-requestable economics field
    // (purchase_price / as_is_value / arv / rehab_budget / units …) may NOT be
    // written LIVE — it becomes a `change_requests` row the loan team approves,
    // exactly as the borrower's info door does (routes/borrower.js). A broker must
    // be no more permissive than a borrower; the broker IS a staff_users row, so
    // the request is attributed to them (requesterKind 'staff', marked via:'tpo')
    // and the existing generic approve/reject flow applies it (re-firing the
    // db/071/072 economics-reopen triggers). Confirming the value already on file
    // (unchanged) simply marks the condition received — no request, no write. The
    // file freeze still takes precedence below (writeFieldValue) for the live path.
    if (changeRequests.isChangeRequestable(item.field_key) && await changeRequests.isBorrowerLocked(req.params.id)) {
      // THE FREEZE IS CHECKED FIRST — a frozen file's economics change must 409,
      // NEVER silently become a change request (the borrower door documents this
      // exact ordering: the sandbox must run AFTER the freeze). None of the
      // change-requestable fields is a payoff-contact field, so the raw field key
      // needs no carve-out translation; actor-less so no super-admin unlock leaks.
      const frozen = await require('../lib/file-lock').payoffContactLockReason(req.params.id, { [item.field_key]: value }, db);
      if (frozen) return res.status(409).json({ error: frozen });
      let cr;
      try {
        cr = await changeRequests.openRequest(req.params.id, item.field_key, value,
          { reason: String((req.body || {}).reason || 'Requested by the broker').slice(0, 500), requesterKind: 'staff', requesterId: req.actor.id });
      } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
      if (cr.unchanged) {
        await db.query(
          `UPDATE checklist_items SET status='received', tool_payload=$2, updated_at=now() WHERE id=$1`,
          [req.params.itemId, JSON.stringify({ infoField: item.field_key, value, submittedAt: new Date().toISOString(), via: 'tpo', confirmedExisting: true })]);
      }
      await tpoAudit(req, 'tpo_answer_info_condition', 'checklist_item', req.params.itemId, { fieldKey: item.field_key, changeRequested: !cr.unchanged });
      try {
        const ctx = await notify.fileContext(req.params.id);
        await notify.notifyAppStaff(req.params.id, {
          type: cr.unchanged ? 'tool_submitted' : 'change_request',
          title: cr.unchanged
            ? `A broker confirmed "${item.borrower_label || item.label}"`
            : `A broker requested a change to ${changeRequests.FIELD_LABELS[item.field_key] || item.field_key}`,
          body: cr.unchanged
            ? `${ctx ? ctx.label : 'A file'} — the value already on file was confirmed; nothing changed.`
            : `${ctx ? ctx.label : 'A file'} — ${changeRequests.describeChange(cr)}. Review and approve or reject it.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: req.params.id,
          link: `/internal/app/${req.params.id}`, ctaLabel: cr.unchanged ? 'Review the file' : 'Review the change' });
      } catch (_) { /* best-effort */ }
      return res.json({ ok: true, locked: true, changeRequested: !cr.unchanged, field: item.field_key });
    }
    // The primary borrower id is writeFieldValue's borrowers-write target — inert
    // here because a borrowers field is refused above; passed for completeness.
    const app = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id])).rows[0] || {};
    let saved;
    try {
      saved = await conditionEngine.writeFieldValue(req.params.id, app.borrower_id, item.field_key, value, { kind: 'staff', id: req.actor.id });
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    await db.query(
      `UPDATE checklist_items SET status='received', tool_payload=$2, updated_at=now() WHERE id=$1`,
      [req.params.itemId, JSON.stringify({ infoField: item.field_key, value: saved.value, submittedAt: new Date().toISOString(), via: 'tpo' })]);
    // Field data changed → the engine may add/retract rule-driven conditions.
    try { await conditionEngine.evaluateApplication(req.params.id, { reason: 'info_condition_answered' }); } catch (_) {}
    await tpoAudit(req, 'tpo_answer_info_condition', 'checklist_item', req.params.itemId, { fieldKey: item.field_key });
    // Tell OUR team a broker answered — reaches the internally-assigned AE / AM
    // (notifyAppStaff filters out external users, so the broker is never a
    // recipient). tool_submitted is an in-app-only staff type (no email storm).
    try {
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppStaff(req.params.id, {
        type: 'tool_submitted',
        title: `A broker answered "${item.borrower_label || item.label}"`,
        body: `${ctx ? ctx.label : 'A file'} — the condition is ready for review.`,
        meta: (ctx && ctx.meta) || undefined, applicationId: req.params.id,
        link: `/internal/app/${req.params.id}`, ctaLabel: 'Review the file' });
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, status: 'received', value: saved.value });
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
    // A broker may only ever set the ONE special kind — the Term Sheet Studio's own
    // generated PDF captured at registration (the "that kind only" pattern, db/424
    // §2b). It auto-attaches to the Products & pricing condition and supersedes the
    // prior term sheet so exactly one is current. Any other docKind is ignored — a
    // broker cannot forge an arbitrary kind onto a document. A BROKER IS AN
    // EXTERNAL, UNTRUSTED PARTY, so — unlike the borrower/staff studio (a trusted
    // surface whose deterministic frozen-engine PDF is born accepted) — a broker's
    // term sheet is handled like db/424's other untrusted system-written docs (a
    // vendor order return, an adopted entity doc): (a) the FINAL/INITIAL stamp is
    // RE-DERIVED server-side from the send gate, so a broker can NEVER forge
    // `termSheetFinal:true` to defeat the DocuSign send's byte-integrity check
    // (orchestrate.js); (b) it is born PENDING, so the LENDER reviews it before it
    // is accepted or ships in any package — a broker provides, WE vouch.
    const isTermSheet = b.docKind === 'term_sheet' && !b.checklistItemId;
    const docKind = isTermSheet ? 'term_sheet' : null;
    let termSheetFinal = null;
    let itemId = null;
    let slot = null;
    if (isTermSheet) {
      // Never accept a term sheet while a fatal appraisal finding holds terms —
      // parity with the borrower + staff upload doors (owner-directed 2026-07-31).
      let hold = null;
      try { hold = await require('../lib/underwriting/appraisal-advisory').appraisalTermSheetHold(db, b.applicationId); } catch (_) {}
      if (hold) return res.status(422).json({ error: 'The terms are being finalized — the loan team is reviewing the appraisal. A term sheet will be available shortly.', code: 'appraisal_hold' });
      // Re-derive the stamp server-side (ignore the client-forgeable flag).
      try { termSheetFinal = !!(await require('../lib/esign/term-sheet-stamp').termSheetStamp(b.applicationId, { db })).final; } catch (_) { termSheetFinal = false; }
      const pp = await db.query(
        `SELECT id FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' ORDER BY created_at LIMIT 1`,
        [b.applicationId]);
      if (pp.rows[0]) { itemId = pp.rows[0].id; slot = 'Term sheet'; }
    } else if (b.checklistItemId) {
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
      applicationId: b.applicationId, checklistItemId: itemId, llcId: null, trackRecordId: null, slotLabel: slot, docKind, termSheetFinal });
    if (dupId) return res.status(201).json({ ok: true, documentId: dupId, deduped: true });
    const { ref, provider } = await storage.save(buf, { filename });
    // Born PENDING — everything a broker uploads (a document OR their term sheet)
    // is reviewed by the lender before it is accepted (see the term-sheet note
    // above). `term_sheet_final` still records what the bytes PRINT (the send gate
    // reads it), but it was re-derived server-side, not trusted from the request.
    const r = await db.query(
      `INSERT INTO documents (checklist_item_id,application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,term_sheet_final,visibility,review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,$11,$12,'borrower','pending') RETURNING id`,
      [itemId, b.applicationId, borrowerId, filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id, docKind, slot, termSheetFinal]);
    if (isTermSheet) {
      // Exactly one term sheet is current — supersede the prior (the register
      // already reopened the Products & pricing condition, so no extra flip here).
      await db.query(
        `UPDATE documents SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE application_id=$1 AND doc_kind='term_sheet' AND id<>$2 AND is_current=true`,
        [b.applicationId, r.rows[0].id]);
    } else if (itemId) {
      // New evidence — clear any prior sign-off so the LENDER re-reviews.
      await db.query(
        `UPDATE checklist_items SET status='received', signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE id=$1 AND audience IN ('borrower','both')`, [itemId]);
    }
    await tpoAudit(req, 'tpo_upload_document', 'document', r.rows[0].id, { applicationId: b.applicationId, checklistItemId: itemId, docKind });
    try { require('../lib/sharepoint-backup').kick(); } catch (_) { /* mirror is best-effort */ }
    res.status(201).json({ ok: true, documentId: r.rows[0].id });
  } catch (e) { next(e); }
});

// ============================================================================
// PHASE 5a — a broker ORDERS a credit pull on the firm's file, on OUR Xactus
// account (own-Xactus per-firm credentials is a later slice). It reuses the ONE
// staff credit machinery (`credit.importCredit`) with the SAME server-side FCRA
// consent gate and prerequisite checks — but the RESULT is BORROWER-SAFE: the
// broker learns only that credit was pulled + who is ready to pull, NEVER a
// score, tradeline, adverse item, or the staff-only credit PDF/XML (all of which
// importCredit produces and hides at visibility='staff_only'). Firm-scoped.
// ============================================================================

// Borrower-safe credit READINESS — per borrower, only whether a pull is possible
// and what PII is still missing (so the broker can fill it). NEVER a score, a
// prior report id/date, or a cross-file reference: `credit.preview` returns those
// (profileReport.middleScore, reissueReportId, fromLoanNumber) and they are
// deliberately DROPPED here — only the four safe fields pass through.
router.get('/applications/:id/credit', async (req, res, next) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    let pv = null;
    try { pv = await require('../lib/credit').preview(req.params.id); } catch (_) { pv = null; }
    const borrowers = (pv && Array.isArray(pv.borrowers) ? pv.borrowers : []).map((b) => ({
      borrowerId: b.borrowerId, role: b.role, name: b.name,
      hasSsn: !!b.hasSsn, canPull: !!b.canPull,
      missing: Array.isArray(b.missing) ? b.missing : [],
      hasReport: !!b.reissueReportId,   // a report is already on THIS file — boolean only, never the id
    }));
    let configured = false;
    try { configured = require('../lib/credit/provider').configured(); } catch (_) { configured = false; }
    res.json({ borrowers, configured, canOrder: configured && borrowers.some((b) => b.canPull) });
  } catch (e) { next(e); }
});

// ORDER a credit pull — a fresh, live pull on OUR account. Firm-scoped, FCRA
// consent-gated (importCredit enforces it server-side too; the pre-check gives a
// plain 400). The RESULT is borrower-safe — never a score/report id/fico; the
// broker sees the credit condition move to "received" via the Lender-progress
// reveal (Phase 4c). The staff-only credit docs + scores + the FICO→pricing
// write-back all fire exactly as a staff pull, and stay staff-only.
router.post('/applications/:id/credit/order', async (req, res) => {
  try {
    if (!(await appInFirm(req.actor.id, req.params.id))) return res.status(404).json({ error: 'file not found' });
    const b = req.body || {};
    if (b.consent !== true) return res.status(400).json({ error: 'Confirm the borrower authorized a credit pull before ordering.' });
    let creditProvider;
    try { creditProvider = require('../lib/credit/provider'); } catch (_) { creditProvider = null; }
    if (!creditProvider || !creditProvider.configured()) {
      return res.status(503).json({ error: 'Credit ordering isn’t available right now — your loan team can pull it.' });
    }
    let out;
    try {
      out = await require('../lib/credit').importCredit(req.params.id, {
        // A broker order is ALWAYS a fresh LIVE pull on our account — never an
        // upload/split/merged (those are staff-only paths), and requestType 'new'
        // (a broker has no prior Xactus reference to reissue).
        pullType: b.pullType === 'hard' ? 'hard' : 'soft',
        requestType: 'new',
        joint: b.joint === true,
        borrowerIds: Array.isArray(b.borrowerIds) ? b.borrowerIds.filter((x) => typeof x === 'string') : undefined,
        consent: true,
        actorId: req.actor.id,
      });
    } catch (e) {
      return res.status(e.status || 422).json({ error: e.userMessage || 'Could not order the credit report.' });
    }
    await tpoAudit(req, 'tpo_order_credit', 'application', req.params.id,
      { pullType: out.pullType, source: out.source, pulled: out.pulled,
        ficoWritten: out.ficoWritten, ficoMismatch: out.ficoMismatch, ficoUnverified: out.ficoUnverified });
    // Tell OUR team a broker ordered credit (in-app only; notifyAppStaff filters
    // out external users, so the broker is never a recipient).
    try {
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppStaff(req.params.id, {
        type: 'tool_submitted',
        title: 'A broker ordered a credit pull',
        body: `${ctx ? ctx.label : 'A file'} — credit was pulled and is ready for review.`,
        meta: (ctx && ctx.meta) || undefined, applicationId: req.params.id,
        link: `/internal/app/${req.params.id}`, ctaLabel: 'Review the file' });
    } catch (_) { /* best-effort */ }
    // BORROWER-SAFE result — never a score, report id, or fico.
    res.status(201).json({ ok: true, message: 'Credit was pulled — your loan team is reviewing it.' });
  } catch (e) { console.error('[tpo credit]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
