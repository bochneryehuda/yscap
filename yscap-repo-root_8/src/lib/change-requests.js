'use strict';

/**
 * Borrower change-request "sandbox" (S5-03 / S2-05).
 *
 * Once a product is REGISTERED, the deal economics are authoritative. A borrower
 * may no longer write them straight onto the live record — a proposed change is
 * held as a `change_requests` row (status 'pending') that the loan officer +
 * processor approve or reject. Approving applies the value in an audited write
 * (which re-fires the existing economics-reopen triggers, db/071/072); rejecting
 * closes it and the live record never changed.
 *
 * This module is the single source of truth for: which fields are governed, when
 * the borrower is locked out, and how a request is opened / applied.
 */
const db = require('../db');
const C = require('./crypto');

// The deal-economics fields a borrower could set via the completeness panel.
// This is exactly the borrower's app-field whitelist (B_COMPLETE_APP) — the same
// inputs the reopen trigger watches. Personal fields (DOB/phone/FICO) are NOT
// here: those aren't the risk and stay directly editable by their owner.
const FIELD_LABELS = {
  program: 'Program',
  loan_type: 'Loan type',
  property_type: 'Property type',
  units: 'Number of units',
  purchase_price: 'Purchase price',
  as_is_value: 'As-is value',
  arv: 'After-repair value (ARV)',
  rehab_budget: 'Rehab budget',
};
const MONEY_FIELDS = new Set(['purchase_price', 'as_is_value', 'arv', 'rehab_budget']);
const INT_FIELDS = new Set(['units']);
// Governed enum fields whose value must be one of a fixed set — validated so a
// hand-crafted request can't smuggle a junk value onto the file even if a
// reviewer approves without looking. property_type, program and loan_type all
// use the SAME option lists the completeness pickers offer, so an approved
// request writes a value the pricing engine already understands.
const FIELD_OPTIONS = {
  property_type: ['SFR', 'Multi 2-4', 'Multi 5+', 'Condo', 'Townhouse', 'Mixed Use'],
  program: ['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction'],
  loan_type: ['Purchase', 'Refinance — Rate & Term', 'Refinance — Cash-Out'],
};
const isGovernedField = (k) => Object.prototype.hasOwnProperty.call(FIELD_LABELS, k);

// PERSONAL identity fields (owner-directed 2026-07-20). Once a file is accepted
// (registered), the borrower can't change ANYTHING directly — not just the deal
// economics above, but their own name / DOB / SSN / phone / credit / citizenship.
// Each personal edit becomes a pending change_request the loan team approves,
// exactly like an economics field, but it targets the `borrowers` row instead of
// `applications`. `ssn` is VIRTUAL: it maps to ssn_encrypted/ssn_last4 and is NEVER
// stored or shown in the clear (masked display + an encrypted payload column).
const BORROWER_FIELD_LABELS = {
  first_name: 'First name',
  last_name: 'Last name',
  date_of_birth: 'Date of birth',
  ssn: 'Social Security number',
  cell_phone: 'Cell phone',
  fico: 'Credit score',
  citizenship: 'Citizenship',
};
const BORROWER_FIELDS = new Set(Object.keys(BORROWER_FIELD_LABELS));
// The real borrowers COLUMN each personal field writes. 'ssn' is null — it is
// handled specially (ssn_encrypted/ssn_last4) and its name is never interpolated.
const BORROWER_FIELD_COLUMN = {
  first_name: 'first_name', last_name: 'last_name', date_of_birth: 'date_of_birth',
  cell_phone: 'cell_phone', fico: 'fico', citizenship: 'citizenship', ssn: null,
};
const ALL_LABELS = Object.assign({}, FIELD_LABELS, BORROWER_FIELD_LABELS);
const isBorrowerField = (k) => BORROWER_FIELDS.has(k);
// Anything a borrower may only CHANGE-REQUEST (never write live) once locked.
const isChangeRequestable = (k) => isGovernedField(k) || isBorrowerField(k);
const fieldEntity = (k) => (BORROWER_FIELDS.has(k) ? 'borrowers' : 'applications');
const labelOf = (k) => ALL_LABELS[k] || k;
const maskSsn = (last4) => (last4 ? `•••-••-${String(last4).slice(-4)}` : '•••-••-••••');

// LINKAGE GUARD: every governed field name (both tables) is interpolated into SQL
// (the value is always parameterized). Assert at load that each is a plain
// snake_case token — so a typo can never become an injection vector or a
// silently-missing write. ('ssn' passes the token test but is never used as a
// column — it routes through the encrypted-column branch.)
for (const f of Object.keys(ALL_LABELS)) {
  if (!/^[a-z][a-z0-9_]*$/.test(f)) throw new Error(`change-requests: unsafe governed field name "${f}"`);
}

// Human-readable value for a field, used in the change-request notifications so
// the borrower + team see the exact before → after (money as $, units as a plain
// count, everything else verbatim).
function formatValue(field, v) {
  if (v == null || v === '') return '—';
  if (MONEY_FIELDS.has(field)) { const n = Number(v); return Number.isFinite(n) ? '$' + n.toLocaleString('en-US') : String(v); }
  if (INT_FIELDS.has(field)) { const n = Number(v); return Number.isFinite(n) ? String(n) : String(v); }
  return String(v);
}
// "After-repair value (ARV): $500,000 → $525,000" — one line, ready to drop into
// a notification body.
function describeChange(cr) {
  const label = cr.field_label || labelOf(cr.field);
  return `${label}: ${formatValue(cr.field, cr.old_value)} → ${formatValue(cr.field, cr.new_value)}`;
}

// A file is "locked" for the borrower once it carries a CURRENT product
// registration — that's the moment terms became authoritative ("after products &
// pricing", per the owner). Before that, the borrower edits freely.
async function isBorrowerLocked(appId, client = db) {
  try {
    const r = await client.query(
      `SELECT 1 FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    return !!r.rows[0];
  } catch (_) {
    return false;   // if we can't tell, don't hard-block the borrower
  }
}

// Normalize an incoming borrower value the same way the live-write paths do, so a
// requested value and the stored value are comparable (money → number string).
function normalizeValue(field, raw) {
  if (raw == null) return null;
  if (MONEY_FIELDS.has(field)) {
    const s = String(raw).replace(/[^0-9.]/g, '');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? String(n) : null;
  }
  if (INT_FIELDS.has(field)) {
    const s = String(raw).replace(/[^0-9-]/g, '');
    if (s === '') return null;
    const n = parseInt(s, 10);
    // units (the only INT field) is a positive count — reject 0 / negative so a
    // borrower can't propose (and a reviewer accidentally approve) units < 1.
    return Number.isFinite(n) && n >= 1 ? String(n) : null;
  }
  return String(raw).trim();
}

// The current live value of a governed field, as a comparable string.
async function currentValue(appId, field, client = db) {
  if (!isGovernedField(field)) return null;
  const r = await client.query(`SELECT ${field} AS v FROM applications WHERE id=$1`, [appId]);
  const v = r.rows[0] ? r.rows[0].v : null;
  return v == null ? null : String(v);
}

/**
 * Open (or supersede-and-open) a pending change request for one field. Returns
 * the new row, or { unchanged:true } when the proposed value equals the live
 * value (nothing to do). Any prior PENDING request for the same field is marked
 * 'superseded' so the queue holds only the latest ask.
 */
async function openRequest(appId, field, rawValue, opts = {}, client = db) {
  // Personal-field requests target the borrowers row (name/DOB/SSN/phone/FICO/…).
  if (isBorrowerField(field)) return openBorrowerRequest(appId, field, rawValue, opts, client);
  const { reason, requesterKind = 'borrower', requesterId = null } = opts;
  if (!isGovernedField(field)) throw Object.assign(new Error('field is not change-requestable'), { status: 400 });
  const newValue = normalizeValue(field, rawValue);
  if (newValue == null || newValue === '') throw Object.assign(new Error('a value is required'), { status: 400 });
  if (FIELD_OPTIONS[field] && !FIELD_OPTIONS[field].includes(newValue))
    throw Object.assign(new Error(`${FIELD_LABELS[field]} must be one of: ${FIELD_OPTIONS[field].join(', ')}`), { status: 400 });
  const oldValue = await currentValue(appId, field, client);
  const oldNorm = normalizeValue(field, oldValue);
  if (oldNorm === newValue) return { unchanged: true, field };
  await client.query(
    `UPDATE change_requests SET status='superseded', updated_at=now()
      WHERE application_id=$1 AND field=$2 AND status='pending'`, [appId, field]);
  const r = await client.query(
    `INSERT INTO change_requests
       (application_id, field, field_label, old_value, new_value, reason, requested_by_kind, requested_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, application_id, field, field_label, old_value, new_value, reason, status, created_at`,
    [appId, field, FIELD_LABELS[field], oldValue, newValue, reason || null, requesterKind, requesterId]);
  return r.rows[0];
}

// Normalize a borrower personal value the way the live profile path does, so a
// requested value and the stored value are comparable. Returns null for invalid
// input (a bad DOB / out-of-range FICO), which openBorrowerRequest rejects.
function normalizeBorrowerValue(field, raw) {
  if (raw == null) return null;
  const F = require('./fields');
  if (field === 'date_of_birth') return F.sanitizeDob(String(raw));           // real adult calendar date or null
  if (field === 'fico') { const n = F.sanitizeFico(raw); return n == null ? null : String(n); }
  if (field === 'first_name' || field === 'last_name') { const s = String(raw).trim(); return s || null; }
  return String(raw).trim();                                                   // cell_phone, citizenship
}

// The current live value of a personal field on the borrower's row, comparable.
async function currentBorrowerValue(borrowerId, field, client = db) {
  const col = BORROWER_FIELD_COLUMN[field];
  if (!col) return null;   // ssn — read separately (masked)
  const r = await client.query(`SELECT ${col} AS v FROM borrowers WHERE id=$1`, [borrowerId]);
  const v = r.rows[0] ? r.rows[0].v : null;
  return v == null ? null : String(v);
}

/**
 * Open (or supersede-and-open) a pending PERSONAL-field change request against the
 * borrower's own row. `targetBorrowerId` is the borrower whose row changes (the
 * requester). SSN is special: the new value is stored ENCRYPTED (new_value_encrypted)
 * and only a MASKED display rides in new_value/old_value — the clear SSN never lands
 * in the queue. Superseding is scoped to this borrower + field so two co-borrowers
 * editing the same field don't cancel each other.
 */
async function openBorrowerRequest(appId, field, rawValue, { reason, requesterKind = 'borrower', requesterId = null, targetBorrowerId = null } = {}, client = db) {
  if (!isBorrowerField(field)) throw Object.assign(new Error('field is not change-requestable'), { status: 400 });
  if (!targetBorrowerId) throw Object.assign(new Error('a target borrower is required'), { status: 400 });
  let newValue, newEncrypted = null, oldValue;
  if (field === 'ssn') {
    const s = C.ssnForStorage(rawValue);
    if (!s) throw Object.assign(new Error('Enter a valid 9-digit SSN.'), { status: 400 });
    newValue = maskSsn(s.last4);
    newEncrypted = s.encrypted;
    const cur = await client.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [targetBorrowerId]);
    oldValue = cur.rows[0] && cur.rows[0].ssn_last4 ? maskSsn(cur.rows[0].ssn_last4) : null;
    // "Unchanged" isn't cheaply detectable for an encrypted SSN — always open the
    // request; a redundant same-SSN ask is rare and harmless.
  } else {
    newValue = normalizeBorrowerValue(field, rawValue);
    if (newValue == null || newValue === '') throw Object.assign(new Error('a value is required'), { status: 400 });
    oldValue = await currentBorrowerValue(targetBorrowerId, field, client);
    if (normalizeBorrowerValue(field, oldValue) === newValue) return { unchanged: true, field };
  }
  await client.query(
    `UPDATE change_requests SET status='superseded', updated_at=now()
      WHERE application_id=$1 AND field=$2 AND target_table='borrowers' AND target_id=$3 AND status='pending'`,
    [appId, field, targetBorrowerId]);
  const r = await client.query(
    `INSERT INTO change_requests
       (application_id, field, field_label, old_value, new_value, new_value_encrypted, reason,
        requested_by_kind, requested_by_id, target_table, target_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrowers',$10)
     RETURNING id, application_id, field, field_label, old_value, new_value, reason, status, created_at`,
    [appId, field, labelOf(field), oldValue, newValue, newEncrypted, reason || null, requesterKind, requesterId, targetBorrowerId]);
  return r.rows[0];
}

// Coerce a stored string value back to the column type for the live write.
function coerceForColumn(field, value) {
  if (MONEY_FIELDS.has(field)) { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (INT_FIELDS.has(field)) { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null; }
  return value;
}

/**
 * Apply an APPROVED request to the live record inside the caller's transaction.
 * Writes the whitelisted column (parameterized value; field name is validated
 * against the whitelist so it can be safely interpolated) and stamps the request
 * approved. The applications UPDATE re-fires the economics-reopen trigger.
 * Returns { field, oldValue, newValue }.
 */
async function applyRequest(client, cr, deciderId, note) {
  if (cr.target_table === 'borrowers') return applyBorrowerRequest(client, cr, deciderId, note);
  if (!isGovernedField(cr.field)) throw Object.assign(new Error('field is not change-requestable'), { status: 400 });
  const value = coerceForColumn(cr.field, cr.new_value);
  await client.query(
    `UPDATE applications SET ${cr.field}=$2, updated_at=now() WHERE id=$1`, [cr.application_id, value]);
  // LINKAGE CHECK (verify-after-write, the repo's #1 bug-class guard): re-read the
  // column and confirm the approved value actually landed on the linked field.
  // Runs inside the caller's transaction, so a mismatch throws → ROLLBACK, and the
  // borrower is never told a change was applied when the field didn't move.
  const back = await client.query(`SELECT ${cr.field} AS v FROM applications WHERE id=$1`, [cr.application_id]);
  const live = back.rows[0] ? back.rows[0].v : null;
  if (normalizeValue(cr.field, live) !== normalizeValue(cr.field, cr.new_value)) {
    throw Object.assign(new Error(`change request did not apply to ${cr.field_label || cr.field} — field linkage failed`), { status: 500 });
  }
  await client.query(
    `UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3, updated_at=now()
      WHERE id=$1`, [cr.id, deciderId, note || null]);
  return { field: cr.field, fieldLabel: cr.field_label, oldValue: cr.old_value, newValue: cr.new_value, entity: 'applications' };
}

/**
 * Apply an APPROVED PERSONAL-field request to the borrower's row inside the caller's
 * transaction. SSN moves as the encrypted payload (never decrypted here) onto
 * ssn_encrypted/ssn_last4; every other field is a whitelisted column write. Same
 * verify-after-write guard as the economics path. Returns { field, ... }.
 */
async function applyBorrowerRequest(client, cr, deciderId, note) {
  if (!isBorrowerField(cr.field)) throw Object.assign(new Error('field is not change-requestable'), { status: 400 });
  const bid = cr.target_id;
  if (!bid) throw Object.assign(new Error('change request has no target borrower'), { status: 500 });
  if (cr.field === 'ssn') {
    if (!cr.new_value_encrypted) throw Object.assign(new Error('SSN change request is missing its encrypted value'), { status: 500 });
    const last4 = (String(cr.new_value || '').replace(/\D/g, '').slice(-4)) || null;
    await client.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, updated_at=now() WHERE id=$1`, [bid, cr.new_value_encrypted, last4]);
    const back = await client.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [bid]);
    if (!back.rows[0] || back.rows[0].ssn_last4 !== last4) {
      throw Object.assign(new Error('SSN change did not apply — field linkage failed'), { status: 500 });
    }
  } else {
    const col = BORROWER_FIELD_COLUMN[cr.field];
    const value = cr.field === 'fico' ? (parseInt(cr.new_value, 10) || null) : cr.new_value;
    await client.query(`UPDATE borrowers SET ${col}=$2, updated_at=now() WHERE id=$1`, [bid, value]);
    const back = await client.query(`SELECT ${col} AS v FROM borrowers WHERE id=$1`, [bid]);
    const live = back.rows[0] ? back.rows[0].v : null;
    if (String(live == null ? '' : live) !== String(cr.new_value == null ? '' : cr.new_value)) {
      throw Object.assign(new Error(`change request did not apply to ${cr.field_label || cr.field} — field linkage failed`), { status: 500 });
    }
  }
  await client.query(
    `UPDATE change_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3, updated_at=now()
      WHERE id=$1`, [cr.id, deciderId, note || null]);
  return { field: cr.field, fieldLabel: cr.field_label, oldValue: cr.old_value, newValue: cr.new_value, entity: 'borrowers', borrowerId: bid };
}

// The governed economics fields, exported so the ClickUp inbound pull can protect
// a freshly-approved value from a stale re-pull (#86). All are FIELD_MAP `both`
// fields — the only ones an approved change request ever writes.
const GOVERNED_FIELDS = Object.keys(FIELD_LABELS);

module.exports = {
  FIELD_LABELS, MONEY_FIELDS, INT_FIELDS, FIELD_OPTIONS, GOVERNED_FIELDS, isGovernedField,
  BORROWER_FIELD_LABELS, BORROWER_FIELDS, isBorrowerField, isChangeRequestable, fieldEntity, labelOf,
  isBorrowerLocked, openRequest, openBorrowerRequest, applyRequest, currentValue, currentBorrowerValue,
  normalizeValue, normalizeBorrowerValue, formatValue, describeChange,
};
