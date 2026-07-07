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
const F = require('./fields');
const identity = require('./identity');
const statusMap = require('./status');
const crosswalk = require('./crosswalk');
const routing = require('./routing');
const transforms = require('./transforms');
const checklist = require('./checklist');

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

/** A masked, structured snapshot of a task's mapped data for long-term
 *  preservation + auditing. SSN → last-4 only; card → boolean. `unmapped` holds
 *  every ClickUp field we did NOT map into the portal (audit: what we're missing). */
function buildMaskedSnapshot(read, extra = {}) {
  const b = read.borrower || {};
  const ssn4 = b.ssn ? String(b.ssn).replace(/\D/g, '').slice(-4) : null;
  return {
    status: read.internalStatus || null,
    rawProgram: read.rawProgram || null,   // raw ClickUp *Program label (non-RTL preserved)
    app: read.app || {},
    borrower: { ...b, ssn: ssn4 ? `***-**-${ssn4}` : undefined },
    llc: read.llc || {},
    unmapped: read.extra || {},
    coBorrower: read.coBorrowerFlagYes || undefined,
    loanOfficerEmail: extra.loanOfficerEmail || read.loanOfficerEmail || null,
    processorEmail: extra.processorEmail || read.processorEmail || null,
    portalFileId: read.portalFileId || null,
    hasCard: !!read.cardLine,
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
  let ssnConflict = false; // set if an email match has a DIFFERENT SSN (two people)

  // 1) strong: exact SSN-hash
  if (ssnHash) {
    const r = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 LIMIT 1`, [ssnHash]);
    if (r.rows[0]) { await recordContacts(r.rows[0].id, b, taskId); return { borrowerId: r.rows[0].id, created: false }; }
  }
  // 2) email exact — a strong-ish signal, BUT guard against a shared email for
  //    two different people: if both sides have an SSN-hash and they DIFFER, do
  //    NOT merge (that would attach this loan/PII to the wrong borrower). Fall
  //    through to create a distinct profile instead.
  if (b.email) {
    const r = await db.query(`SELECT id, ssn_hash FROM borrowers WHERE email=$1 LIMIT 1`, [String(b.email).toLowerCase().trim()]);
    if (r.rows[0]) {
      ssnConflict = ssnHash && r.rows[0].ssn_hash && ssnHash !== r.rows[0].ssn_hash;
      if (!ssnConflict) {
        if (ssnHash) await db.query(`UPDATE borrowers SET ssn_hash=COALESCE(ssn_hash,$1) WHERE id=$2`, [ssnHash, r.rows[0].id]);
        await recordContacts(r.rows[0].id, b, taskId);
        return { borrowerId: r.rows[0].id, created: false };
      }
    }
  }
  // 3) weak: >=2 identity fields among recent candidates (name/phone) -> create + queue confirm
  //    (kept cheap: candidate pool by last name / phone digits)
  // 4) none -> create a shadow profile
  const first = b.first_name || 'Unknown', last = b.last_name || 'Unknown';
  // CRITICAL: if the email belongs to a DIFFERENT person (SSN conflict above), do
  // NOT reuse it here — the INSERT's ON CONFLICT (email) DO UPDATE would resolve to
  // that other person's row and re-merge the two we just refused to merge (wrong
  // loan/PII attachment). Use a synthetic unique email so a distinct profile is created.
  const email = (b.email && !ssnConflict) ? String(b.email).toLowerCase().trim() : `noemail+${taskId}@clickup.local`;
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
    // Also (re)fill the property address — early track records were written with
    // the raw ClickUp location shape (or none), so a re-run repopulates them with
    // the normalized address. COALESCE keeps an existing value if this read lacks one.
    await db.query(`UPDATE track_records SET deal_type=$2, inferred=$3,
                      property_address=COALESCE($4, property_address), updated_at=now() WHERE id=$1`,
      [exists.rows[0].id, dealType, inferred, a.property_address ? JSON.stringify(a.property_address) : null]).catch(() => {});
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

/** Resolve a ClickUp officer/processor email → an active staff_users row. */
async function resolveStaffByEmail(email) {
  if (!email) return { id: null, name: null };
  const r = await db.query(
    `SELECT id, full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active=true LIMIT 1`, [email]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].full_name } : { id: null, name: null };
}

/** Resolve a ClickUp numeric user id → an active staff_users row (mirrors
 *  resolveStaffByEmail). Used for "users" custom fields — e.g. Underwriter —
 *  where the ClickUp member id is the stable key into staff_users.clickup_user_id. */
async function resolveStaffByClickupUserId(clickupUserId) {
  if (clickupUserId == null || clickupUserId === '') return { id: null, name: null };
  const r = await db.query(
    `SELECT id, full_name FROM staff_users WHERE clickup_user_id=$1 AND is_active=true LIMIT 1`, [clickupUserId]
  ).catch(() => ({ rows: [] }));
  return r.rows[0] ? { id: r.rows[0].id, name: r.rows[0].full_name } : { id: null, name: null };
}

/** First ClickUp user id from a "users" custom field on a raw task (or null).
 *  Mirrors the mapper's officer/processor read: take the first user, prefer .id.
 *  The Underwriter field is in the mapper's KNOWN set (never surfaced in extra),
 *  so we read it straight off the task here. */
function firstUserIdFromField(task, fieldId) {
  const cf = ((task && task.custom_fields) || []).find((c) => c && c.id === fieldId);
  if (!cf || !Array.isArray(cf.value) || !cf.value.length) return null;
  const u = cf.value[0];
  return (u && (u.id != null ? u.id : u)) || null;
}

const _addrOf = (v) => (v && (v.formatted_address || v.oneLine)) || null;

/**
 * Find which EXISTING portal app a task belongs to, without creating one:
 *   1) Portal File ID stamp (authoritative — written by our own push).
 *   2) Within the resolved borrower's unlinked RTL apps, an app-level match on
 *      normalized property ADDRESS or ys_loan_number (each uniquely identifies
 *      the deal for a fixed borrower). Single strong match links; multiple ->
 *      ambiguous (Manual Review); none -> null (create).
 * Returns { id, how, detail } | { ambiguous, detail } | null.
 */
async function findExistingApp(task, read, borrowerId) {
  if (read.portalFileId) {
    const s = await db.query(
      `SELECT id, clickup_pipeline_task_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [read.portalFileId]
    ).catch(() => ({ rows: [] }));
    if (s.rows[0]) {
      const linked = s.rows[0].clickup_pipeline_task_id;
      if (!linked || linked === task.id) return { id: s.rows[0].id, how: 'linked_stamp', detail: { stamp: read.portalFileId } };
      return { ambiguous: true, detail: { stamp: read.portalFileId, boundToTask: linked } };
    }
    // stale stamp (app deleted) -> fall through
  }
  // ys_loan_number is a GLOBAL unique key — same number == same loan. Match it
  // across ALL borrowers (not just the resolved one) so a re-linked/re-keyed file
  // links instead of colliding on the unique index (which would otherwise throw).
  if (read.app.ys_loan_number) {
    const ln = await db.query(
      `SELECT id, clickup_pipeline_task_id FROM applications WHERE ys_loan_number=$1 AND deleted_at IS NULL LIMIT 1`,
      [read.app.ys_loan_number]
    ).catch(() => ({ rows: [] }));
    if (ln.rows[0]) {
      const linked = ln.rows[0].clickup_pipeline_task_id;
      if (!linked || linked === task.id) return { id: ln.rows[0].id, how: 'linked_loannum', detail: { ysLoanNumber: read.app.ys_loan_number } };
      return { ambiguous: true, detail: { ysLoanNumber: read.app.ys_loan_number, boundToTask: linked } };
    }
  }
  const cand = await db.query(
    `SELECT id, property_address, ys_loan_number, purchase_price FROM applications
      WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NULL
        AND program IN ('Fix & Flip w/ Construction','Bridge','Ground-Up Construction')`, [borrowerId]
  ).catch(() => ({ rows: [] }));
  if (!cand.rows.length) return null;
  const tn = identity.normalizeIdentity({
    address: _addrOf(read.app.property_address), loanNumber: read.app.ys_loan_number, purchasePrice: read.app.purchase_price,
  });
  const strong = [];
  for (const c of cand.rows) {
    const cn = identity.normalizeIdentity({ address: _addrOf(c.property_address), loanNumber: c.ys_loan_number, purchasePrice: c.purchase_price });
    const addr = tn.address && tn.address === cn.address;
    const loan = tn.loanNumber && tn.loanNumber === cn.loanNumber;
    if (addr || loan) strong.push({ id: c.id, addr: !!addr, loan: !!loan });
  }
  if (strong.length === 1) return { id: strong[0].id, how: 'linked_identity', detail: strong[0] };
  if (strong.length > 1)  return { ambiguous: true, detail: { candidates: strong.map((s) => s.id) } };
  return null;
}

/**
 * PULL-ONLY: mirror the ClickUp checklist status dropdowns onto the portal's
 * document conditions for a LINKED RTL file. Reads the task's dropdown fields,
 * translates each to a portal status, and applies the authority / no-downgrade
 * rule (the portal is the system of record). Writes ONLY to checklist_items and
 * touches ONLY items whose clickup_field_id was seeded (db/050) — unmapped
 * fields (title/insurance/signedTermSheet) never match a row and are skipped.
 *
 * CRITICAL LOOPBACK GUARD: this function contains NO enqueue/push of any kind.
 * The physical absence of any outbound call here is what prevents a pull→push
 * echo. It is best-effort (try/catch) so a checklist glitch never breaks ingest.
 */
async function applyChecklistStatuses(appId, task, options = {}) {
  try {
    if (!appId || !task) return;
    const cfById = {};
    for (const c of (task.custom_fields || [])) { if (c && c.id) cfById[c.id] = c; }

    for (const fieldId of Object.keys(checklist.BY_FIELD)) {
      const cf = cfById[fieldId];
      if (!cf || cf.value == null || cf.value === '') continue;

      // ClickUp reads a dropdown as the option's orderindex INTEGER; translate to
      // the option UUID via the same helper the mapper uses. Fall back to treating
      // the value as a direct UUID only if it is a REAL option for this field.
      const optList = options[fieldId] || (cf.type_config && cf.type_config.options) || [];
      let optId = transforms.dropdownIndexToId(optList, cf.value);
      if (!optId && checklist.normalizeInbound(fieldId, String(cf.value))) optId = String(cf.value);
      if (!optId) continue;

      const inbound = checklist.normalizeInbound(fieldId, optId);
      if (!inbound) continue;

      // Only mapped items are ever touched (clickup_field_id seeded by db/050).
      const row = await db.query(
        `SELECT id, status FROM checklist_items
          WHERE application_id=$1 AND clickup_field_id=$2
          ORDER BY updated_at DESC LIMIT 1`, [appId, fieldId]);
      if (!row.rows[0]) continue;

      const cur = row.rows[0].status;
      if (!checklist.shouldApplyInbound(inbound, cur)) continue;

      await db.query(
        `UPDATE checklist_items SET status=$2, clickup_option_id=$3, updated_at=now() WHERE id=$1`,
        [row.rows[0].id, inbound, optId]);
    }
  } catch (_) { /* best-effort — a checklist glitch never breaks ingest */ }
}

/**
 * Ingest one ClickUp task. `options` = live dropdown option map.
 * Builds the identity graph for every task; materializes / links an RTL loan
 * file (with loan-officer assignment) only for in-scope programs.
 */
async function ingestTask(task, options = {}, opts = {}) {
  const read = mapper.readTaskFields(task, options);
  const program = read.app.program || null;
  const isRtl = program && RTL_PROGRAMS.has(program);
  const folderId = (task && task.folder && task.folder.id) || opts.folderId || null;

  const { borrowerId } = await resolveBorrower(read, task.id);
  const llcId = await upsertLlc(borrowerId, read.llc.llc_name, read.llc.ein, task.id);
  if (CLOSED_STATUSES(read.internalStatus)) { try { await upsertTrackRecord(borrowerId, read, task.id); } catch (_) {} }

  // Loan officer comes from the PIPELINE folder (or the Loan Officer Email field);
  // processor from the Processor Email field. Both resolve to a staff_users id.
  const loanOfficerEmail = routing.loanOfficerEmailFor(read, folderId);
  const processorEmail = routing.processorEmailFor(read);

  let applicationId = null, matchStatus = isRtl ? null : 'data_only', matchDetail = null;
  if (isRtl) {
    const res = await linkOrCreateApplication(task, read, borrowerId, llcId,
      { allowCreate: opts.createFile === true, folderId, loanOfficerEmail, processorEmail });
    applicationId = res.applicationId; matchStatus = res.matchStatus; matchDetail = res.detail || null;
  }

  // PULL-ONLY checklist status mirror — ClickUp dropdown → portal condition — for
  // a linked RTL file only (application id present). Writes solely to the portal
  // DB; NEVER enqueues/pushes to ClickUp (loopback guard). Best-effort inside.
  if (isRtl && applicationId) {
    await applyChecklistStatuses(applicationId, task, options);
  }

  // Preserve a MASKED snapshot of every task's mapped data — RTL and non-RTL
  // (long-term) alike — so no ClickUp data is lost even for file types we don't
  // materialize as loan files yet. SSN/card are masked; never cleartext here.
  const snapshot = buildMaskedSnapshot(read, { loanOfficerEmail, processorEmail });
  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, program, ssn_hash, borrower_id, application_id, llc_id,
        match_status, match_detail, snapshot, snapshot_at, task_name, folder_id, internal_status, last_seen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,$13,now())
     ON CONFLICT (task_id) DO UPDATE SET program=EXCLUDED.program, ssn_hash=EXCLUDED.ssn_hash,
        borrower_id=EXCLUDED.borrower_id, application_id=COALESCE(EXCLUDED.application_id, clickup_task_index.application_id),
        llc_id=EXCLUDED.llc_id, match_status=EXCLUDED.match_status, match_detail=EXCLUDED.match_detail,
        snapshot=EXCLUDED.snapshot, snapshot_at=now(), task_name=EXCLUDED.task_name, folder_id=EXCLUDED.folder_id,
        internal_status=EXCLUDED.internal_status, last_seen=now()`,
    [task.id, isRtl ? 'rtl_file' : 'data_only', program, identity.ssnHash(read.borrower.ssn, cfg.ssnMatchKey),
     borrowerId, applicationId, llcId, matchStatus, matchDetail ? JSON.stringify(matchDetail) : null,
     JSON.stringify(snapshot), task.name || null, folderId ? String(folderId) : null, read.internalStatus || null]).catch(() => {});

  return { borrowerId, llcId, applicationId, isRtl, matchStatus };
}

/**
 * Link a task to its portal RTL file (assigning the loan officer) or, when
 * allowed, create one. allowCreate=false still LINKS (stamp/identity) and
 * UPDATES an existing file — only new-file creation is gated.
 * Returns { applicationId, matchStatus, detail }.
 */
async function linkOrCreateApplication(task, read, borrowerId, llcId, ctx = {}) {
  const { allowCreate = false, folderId = null, loanOfficerEmail = null, processorEmail = null } = ctx;
  const a = read.app || {};
  const lo = await resolveStaffByEmail(loanOfficerEmail);
  const pr = await resolveStaffByEmail(processorEmail);
  // Underwriter comes from ClickUp's "Underwriter" users field (may hold several
  // users — take the first), matched to staff_users by clickup_user_id. Pull-only.
  const uw = await resolveStaffByClickupUserId(firstUserIdFromField(task, F.PIPELINE.underwriter));
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
    // Round 3: additional staff-workflow detail (pull-only; ClickUp is source of truth).
    actual_rate: a.actual_rate, desired_rate: a.desired_rate,
    property_taxes: a.property_taxes, property_insurance: a.property_insurance,
    property_hoa: a.property_hoa, rental_income: a.rental_income,
    prepayment_penalty: a.prepayment_penalty,
    title_company: a.title_company, title_company_contact: a.title_company_contact,
    insurance_company: a.insurance_company, insurance_company_contact: a.insurance_company_contact,
    first_lien: a.first_lien, second_lien: a.second_lien,
    appraised_rental_value: a.appraised_rental_value, approx_appraised_rental_value: a.approx_appraised_rental_value,
    cda_value: a.cda_value, appraiser_name: a.appraiser_name,
    encompass_status: a.encompass_status, application_submitted: a.application_submitted,
    property_address: a.property_address ? JSON.stringify(a.property_address) : null,
    internal_status: internal, status: external,
    clickup_extra: Object.keys(read.extra).length ? JSON.stringify(read.extra) : null,
    // Officer assignment (COALESCE on update: reassign when resolved, keep when not).
    loan_officer_id: lo.id, loan_officer_name: lo.name, processor_id: pr.id,
    // Underwriter assignment — same COALESCE semantics: set when resolved, keep when not.
    underwriter_id: uw.id,
    clickup_folder_id: folderId != null ? Number(folderId) : null,
  };

  // Which existing app? task_id link first, then stamp/identity.
  let targetId = null, matchStatus = null, detail = null;
  const byTask = await db.query(`SELECT id FROM applications WHERE clickup_pipeline_task_id=$1 LIMIT 1`, [task.id]);
  if (byTask.rows[0]) { targetId = byTask.rows[0].id; matchStatus = 'linked_task'; }
  else {
    const m = await findExistingApp(task, read, borrowerId);
    if (m && m.ambiguous) return { applicationId: null, matchStatus: 'ambiguous', detail: m.detail };
    if (m && m.id) { targetId = m.id; matchStatus = m.how; detail = m.detail || null; }
  }

  const vals = Object.values(cols);
  const set = Object.keys(cols).map((k, i) => `${k}=COALESCE($${i + 2}, ${k})`).join(', ');
  if (targetId) {
    await db.query(
      `UPDATE applications SET ${set}, clickup_pipeline_task_id=$${vals.length + 2}, sync_state='linked',
              clickup_last_synced_at=now(), updated_at=now() WHERE id=$1`,
      [targetId, ...vals, task.id]);
    return { applicationId: targetId, matchStatus, detail };
  }
  if (!allowCreate) return { applicationId: null, matchStatus: 'skipped' };

  // Create (race-safe: the partial unique index on clickup_pipeline_task_id makes
  // a concurrent duplicate INSERT resolve to the existing row instead of a dup).
  // Stamp clickup_last_synced_at on CREATE (mirroring the UPDATE branch). Without
  // it a freshly-pulled file has clickup_last_synced_at=NULL, which the outbound
  // dirty-sweep reads as "dirty" and immediately echoes back to ClickUp — a pull→
  // push loopback for every inbound-created file.
  const keys = ['borrower_id', 'llc_id', 'clickup_pipeline_task_id', 'source', 'sync_state', 'clickup_last_synced_at', ...Object.keys(cols)];
  const insVals = [borrowerId, llcId, task.id, 'clickup_backfill', 'linked', new Date(), ...vals];
  const ph = insVals.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(
    `INSERT INTO applications (${keys.join(',')}) VALUES (${ph})
     ON CONFLICT (clickup_pipeline_task_id) WHERE clickup_pipeline_task_id IS NOT NULL
     DO UPDATE SET clickup_last_synced_at=now(), updated_at=now() RETURNING id`, insVals);
  return { applicationId: r.rows[0].id, matchStatus: 'created' };
}

module.exports = {
  ingestTask, resolveBorrower, upsertLlc, upsertTrackRecord, linkOrCreateApplication,
  applyChecklistStatuses, identityFrom, RTL_PROGRAMS,
};
