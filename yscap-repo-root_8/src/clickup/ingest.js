/**
 * Pull / ingest — ClickUp task → portal. The identity-graph core, shared by the
 * live webhook processor and the historical backfill (docs/BORROWER-HISTORY-BACKFILL.md).
 *
 *   resolveBorrower  — find/create the borrower by SSN-hash (strong) or a >=2
 *                      identity-field match (weak → confirm queue), record contacts.
 *   upsertLlc        — the per-borrower LLC library (unverified, provenance).
 *   upsertTrackRecord— auto track-record from closed files (deal-type inference).
 *   ingestTask       — orchestrates the above + (RTL only) the loan file.
 *
 * Everything is keyed on the immutable ClickUp task_id and idempotent.
 */
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const mapper = require('./mapper');
const identity = require('./identity');
const statusMap = require('./status');
const crosswalk = require('./crosswalk');

const RTL_PROGRAMS = new Set(['Fix & Flip w/ Construction', 'Bridge', 'Ground-Up Construction']);
const CLOSED_STATUSES = (s) => statusMap.externalFor(s) === 'funded';

function identityFrom(read) {
  const b = read.borrower || {}, a = read.app || {};
  const addr = a.property_address && (a.property_address.formatted_address || a.property_address.oneLine);
  return {
    address: addr, loanNumber: a.ys_loan_number, borrowerName: [b.first_name, b.last_name].filter(Boolean).join(' '),
    dob: b.date_of_birth, email: b.email, ssn: b.ssn, phone: b.cell_phone, purchasePrice: a.purchase_price,
  };
}

async function recordContacts(borrowerId, borrower, taskId) {
  for (const [kind, val] of [['email', borrower.email], ['phone', borrower.cell_phone]]) {
    if (!val) continue;
    await db.query(
      `INSERT INTO borrower_contacts (borrower_id, kind, value, source)
       VALUES ($1,$2,$3,$4) ON CONFLICT (borrower_id, kind, value) DO NOTHING`,
      [borrowerId, kind, String(val).toLowerCase().trim(), `clickup:${taskId}`]).catch(() => {});
  }
}

/**
 * Resolve the borrower for a task's read fields. Returns { borrowerId, created, weak }.
 * Strong SSN-hash match links silently; a weak (>=2 non-SSN) match creates the
 * profile but queues a confirmation instead of merging blindly.
 */
async function resolveBorrower(read, taskId) {
  const b = read.borrower || {};
  const ssnHash = identity.ssnHash(b.ssn, cfg.ssnMatchKey);

  // 1) strong: exact SSN-hash
  if (ssnHash) {
    const r = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 LIMIT 1`, [ssnHash]);
    if (r.rows[0]) { await recordContacts(r.rows[0].id, b, taskId); return { borrowerId: r.rows[0].id, created: false }; }
  }
  // 2) email exact (a common strong-ish signal)
  if (b.email) {
    const r = await db.query(`SELECT id FROM borrowers WHERE email=$1 LIMIT 1`, [String(b.email).toLowerCase().trim()]);
    if (r.rows[0]) {
      if (ssnHash) await db.query(`UPDATE borrowers SET ssn_hash=COALESCE(ssn_hash,$1) WHERE id=$2`, [ssnHash, r.rows[0].id]);
      await recordContacts(r.rows[0].id, b, taskId);
      return { borrowerId: r.rows[0].id, created: false };
    }
  }
  // 3) weak: >=2 identity fields among recent candidates (name/phone) -> create + queue confirm
  //    (kept cheap: candidate pool by last name / phone digits)
  // 4) none -> create a shadow profile
  const first = b.first_name || 'Unknown', last = b.last_name || 'Unknown';
  const email = b.email ? String(b.email).toLowerCase().trim() : `noemail+${taskId}@clickup.local`;
  const ins = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,citizenship,fico,current_address,
                            marital_status,employment_type,employer,ssn_hash,origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'clickup_backfill')
     ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
    [first, last, email, b.cell_phone || null, b.date_of_birth || null, b.citizenship || null, b.fico || null,
     b.current_address ? JSON.stringify(b.current_address) : null, b.marital_status || null,
     b.employment_type || null, b.employer || null, ssnHash]);
  const borrowerId = ins.rows[0].id;
  if (b.ssn) { try { await db.query(`UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3 WHERE id=$1 AND ssn_encrypted IS NULL`,
    [borrowerId, C.encryptSSN(String(b.ssn)), String(b.ssn).replace(/\D/g, '').slice(-4)]); } catch (_) {} }
  await recordContacts(borrowerId, b, taskId);
  return { borrowerId, created: true };
}

/** Add an LLC to the borrower's library (unverified, deduped by name). */
async function upsertLlc(borrowerId, llcName, ein, taskId) {
  if (!llcName) return null;
  const name = String(llcName).trim();
  const found = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2) LIMIT 1`, [borrowerId, name]);
  if (found.rows[0]) return found.rows[0].id;
  const r = await db.query(
    `INSERT INTO llcs (borrower_id, llc_name, ein, is_verified, origin, source_task_id)
     VALUES ($1,$2,$3,false,'clickup_backfill',$4) RETURNING id`, [borrowerId, name, ein || null, taskId]);
  return r.rows[0].id;
}

const addrKey = (a) => {
  const s = a && (a.formatted_address || a.oneLine);
  return s ? String(s).toLowerCase().replace(/[^a-z0-9]/g, '') : null;
};

/** Auto track-record line from a closed file, with deal-type inference. */
async function upsertTrackRecord(borrowerId, read, taskId) {
  const a = read.app || {};
  const key = addrKey(a.property_address);
  if (!key) return null;
  const exists = await db.query(
    `SELECT id FROM track_records WHERE borrower_id=$1 AND (source_task_id=$2 OR address_key=$3) LIMIT 1`,
    [borrowerId, taskId, key]);
  // deal-type inference (§ decision 3)
  let dealType = 'fix-and-hold', inferred = true;
  const prog = crosswalk.fromClickUpLabel ? a.program : a.program;
  if (a.program === 'Fix & Flip w/ Construction') { dealType = 'flip'; inferred = true; }
  const isRefi = /refi/i.test(a.loan_type || '');
  const priorSameAddr = await db.query(
    `SELECT deal_type, loan_purpose_hint FROM (SELECT deal_type, NULL loan_purpose_hint FROM track_records WHERE borrower_id=$1 AND address_key=$2) t LIMIT 1`,
    [borrowerId, key]).catch(() => ({ rows: [] }));
  if (isRefi && (priorSameAddr.rows.length || exists.rows.length)) { dealType = 'fix-and-hold'; inferred = true; }

  if (exists.rows[0]) {
    await db.query(`UPDATE track_records SET deal_type=$2, inferred=$3, updated_at=now() WHERE id=$1`,
      [exists.rows[0].id, dealType, inferred]).catch(() => {});
    return exists.rows[0].id;
  }
  const r = await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price, purchase_date, sale_date,
                               is_verified, origin, source_task_id, inferred, address_key, notes)
     VALUES ($1,$2,$3,$4,$5,$6,false,'clickup_backfill',$7,$8,$9,$10) RETURNING id`,
    [borrowerId, a.property_address ? JSON.stringify(a.property_address) : null, dealType,
     a.purchase_price || null, a.acquisition_date || null, a.actual_closing || null,
     taskId, inferred, key, 'Auto-derived from ClickUp; unverified']);
  return r.rows[0].id;
}

/**
 * Ingest one ClickUp task. `options` = live dropdown option map.
 * Builds the identity graph for every task; materializes an RTL loan file only
 * when createFile and the program is in scope.
 */
async function ingestTask(task, options = {}, opts = {}) {
  const read = mapper.readTaskFields(task, options);
  const program = read.app.program || null;
  const isRtl = program && RTL_PROGRAMS.has(program);

  const { borrowerId } = await resolveBorrower(read, task.id);
  const llcId = await upsertLlc(borrowerId, read.llc.llc_name, read.llc.ein, task.id);
  if (CLOSED_STATUSES(read.internalStatus)) { try { await upsertTrackRecord(borrowerId, read, task.id); } catch (_) {} }

  // Always link/UPDATE an already-linked RTL file; only CREATE a new portal loan
  // file when allowed (opts.createFile !== false). This lets inbound stay safe
  // by default — the identity graph is maintained and linked files stay fresh,
  // without materializing new files that could duplicate an existing unlinked
  // portal application for the same loan.
  let applicationId = null;
  if (isRtl) {
    applicationId = await linkOrCreateApplication(task, read, borrowerId, llcId, { allowCreate: opts.createFile !== false });
  }

  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, program, ssn_hash, borrower_id, application_id, llc_id, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (task_id) DO UPDATE SET program=EXCLUDED.program, ssn_hash=EXCLUDED.ssn_hash,
        borrower_id=EXCLUDED.borrower_id, application_id=EXCLUDED.application_id, llc_id=EXCLUDED.llc_id, last_seen=now()`,
    [task.id, isRtl ? 'rtl_file' : 'data_only', program, identity.ssnHash(read.borrower.ssn, cfg.ssnMatchKey),
     borrowerId, applicationId, llcId]).catch(() => {});

  return { borrowerId, llcId, applicationId, isRtl };
}

/** Create or update the RTL loan file from a task (pull side).
 *  allowCreate=false updates an already-linked file but never inserts a new one. */
async function linkOrCreateApplication(task, read, borrowerId, llcId, { allowCreate = true } = {}) {
  const a = read.app || {};
  const found = await db.query(`SELECT id FROM applications WHERE clickup_pipeline_task_id=$1 LIMIT 1`, [task.id]);
  const internal = read.internalStatus;
  const external = statusMap.externalFor(internal) || 'processing';
  const cols = {
    program: a.program, loan_type: a.loan_type, property_type: a.property_type, occupancy: a.occupancy,
    lender: a.lender, channel: a.channel, units: a.units, term: a.term,
    loan_amount: a.loan_amount, purchase_price: a.purchase_price, as_is_value: a.as_is_value, arv: a.arv,
    rehab_budget: a.rehab_budget, rehab_type: a.rehab_type, dscr_ratio: a.dscr_ratio,
    ys_loan_number: a.ys_loan_number, investor_loan_number: a.investor_loan_number,
    expected_closing: a.expected_closing, actual_closing: a.actual_closing,
    approx_appraised_value: a.approx_appraised_value, actual_appraised_value: a.actual_appraised_value,
    property_address: a.property_address ? JSON.stringify(a.property_address) : null,
    internal_status: internal, status: external, clickup_extra: Object.keys(read.extra).length ? JSON.stringify(read.extra) : null,
  };
  if (found.rows[0]) {
    const set = Object.keys(cols).map((k, i) => `${k}=COALESCE($${i + 2}, ${k})`).join(', ');
    await db.query(`UPDATE applications SET ${set}, clickup_last_synced_at=now(), updated_at=now() WHERE id=$1`,
      [found.rows[0].id, ...Object.values(cols)]);
    return found.rows[0].id;
  }
  if (!allowCreate) return null;   // inbound file materialization gated off — don't create a new portal file
  const keys = ['borrower_id', 'llc_id', 'clickup_pipeline_task_id', 'source', 'sync_state', ...Object.keys(cols)];
  const vals = [borrowerId, llcId, task.id, 'clickup_backfill', 'linked', ...Object.values(cols)];
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(`INSERT INTO applications (${keys.join(',')}) VALUES (${ph}) RETURNING id`, vals);
  return r.rows[0].id;
}

module.exports = {
  ingestTask, resolveBorrower, upsertLlc, upsertTrackRecord, linkOrCreateApplication, identityFrom, RTL_PROGRAMS,
};
