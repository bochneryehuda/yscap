/**
 * Push orchestrator — portal → ClickUp. Glues the DB, the mapper, the live
 * option registry, routing, and the REST client to create or update a Pipeline
 * task from a portal application. Pull/ingest lives in ingest.js (shared with the
 * backfill). Loop-safety on the inbound pull of our own write is structural
 * (idempotent COALESCE + no-downgrade checklist + scoped enqueue-on-write), not a
 * separate echo-suppression pass.
 *
 * Gated by cfg.clickupSyncEnabled; every call is a no-op when the master switch
 * is off, so this is safe to wire before go-live.
 */
const db = require('../db');
const cfg = require('../config');
const clickup = require('./client');
const registry = require('./registry');
const mapper = require('./mapper');
const statusMap = require('./status');
const routing = require('./routing');

let _address = null;
function geocoder() {
  if (_address === null) { try { _address = require('../lib/address'); } catch { _address = false; } }
  return _address || null;
}

/** First list inside a folder (files live in a list within the officer folder). */
async function firstListId(folderId) {
  const r = await clickup.getFolderLists(folderId);
  return r && r.lists && r.lists[0] ? r.lists[0].id : null;
}

/** Attach {lat,lng} to a portal address jsonb via our server-side geocoder. */
async function withCoords(addr) {
  if (!addr || (addr.lat != null && addr.lng != null)) return addr;
  const g = geocoder();
  const line = addr.oneLine || [addr.line1 || addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
  if (!g || !line) return addr;
  try {
    const hit = g.geocode ? await g.geocode(line) : null;
    if (hit && hit.lat != null && hit.lng != null) return { ...addr, lat: hit.lat, lng: hit.lng, formatted_address: hit.formatted || line };
  } catch (_) { /* best effort */ }
  return addr;
}

/** Load everything the mapper needs to build a task from an application. */
async function loadPushContext(appId) {
  const r = await db.query(
    `SELECT a.*, b.first_name, b.last_name, b.email AS b_email, b.cell_phone, b.date_of_birth,
            b.ssn_encrypted, b.fico AS b_fico, b.current_address, b.citizenship, b.marital_status,
            b.employment_type, b.employer, b.dependents_count, b.years_at_residence, b.housing_status, b.housing_payment,
            l.llc_name, l.ein,
            lo.clickup_user_id AS officer_cuid, lo.full_name AS officer_name,
            pr_s.clickup_user_id AS processor_cuid,
            reg.program AS registered_program
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
       LEFT JOIN staff_users pr_s ON pr_s.id = a.processor_id
       LEFT JOIN product_registrations reg ON reg.application_id = a.id AND reg.is_current = true
      WHERE a.id = $1`, [appId]);
  const row = r.rows[0];
  if (!row) return null;

  let ssn = null;
  if (row.ssn_encrypted) { try { ssn = require('../lib/crypto').decryptSSN(row.ssn_encrypted); } catch (_) {} }

  const ctx = {
    app: {
      program: row.program, loan_type: row.loan_type, property_type: row.property_type, occupancy: row.occupancy,
      units: row.units, term: row.term, ppp: row.ppp, ltv: row.ltv, rate_pct: row.rate_pct,
      loan_amount: row.loan_amount, purchase_price: row.purchase_price, as_is_value: row.as_is_value, arv: row.arv,
      rehab_budget: row.rehab_budget, rehab_type: row.rehab_type, dscr_ratio: row.dscr_ratio,
      is_assignment: row.is_assignment,
      assignment_fee: row.assignment_fee, underlying_contract_price: row.underlying_contract_price,
      original_purchase_price: row.original_purchase_price, acquisition_date: row.acquisition_date,
      ys_loan_number: row.ys_loan_number, expected_closing: row.expected_closing, submitted_at: row.submitted_at,
      internal_status: row.internal_status || null,
      property_address: await withCoords(row.property_address),
    },
    borrower: {
      first_name: row.first_name, last_name: row.last_name, email: row.b_email, cell_phone: row.cell_phone,
      date_of_birth: row.date_of_birth, fico: row.b_fico, ssn, citizenship: row.citizenship,
      marital_status: row.marital_status, employment_type: row.employment_type, employer: row.employer,
      dependents_count: row.dependents_count, years_at_residence: row.years_at_residence,
      housing_status: row.housing_status, housing_payment: row.housing_payment,
      current_address: await withCoords(row.current_address),
    },
    llc: row.llc_name ? { llc_name: row.llc_name, ein: row.ein } : null,
    registeredProgram: row.registered_program || 'none',
    externalStatus: row.status,
    // ClickUp "users" fields need a NUMERIC id; node-pg returns bigint as a
    // string, so coerce or the assignment write is silently rejected.
    officerClickupId: row.officer_cuid != null ? Number(row.officer_cuid) : null,
    processorClickupId: row.processor_cuid != null ? Number(row.processor_cuid) : null,
    officerName: row.officer_name || row.loan_officer_name || null,
    portalAppId: appId,
    portalFileLink: `${cfg.appUrl}${cfg.portalPath}/#/internal/app/${appId}`,
    _row: row,
  };
  // Phase B: mapped checklist condition statuses, for a possible SCOPED push to
  // their ClickUp dropdowns (only ever pushed when a checklist:<fieldId> key is
  // explicitly named in opts.only — see pushApplication).
  try {
    const ck = await db.query(
      `SELECT clickup_field_id AS "fieldId", status FROM checklist_items
        WHERE application_id=$1 AND clickup_field_id IS NOT NULL`, [appId]);
    ctx.checklist = ck.rows;
  } catch (_) { ctx.checklist = []; }
  return ctx;
}

/** Create or update the Pipeline task for an application. No-op if sync disabled. */
async function pushApplication(appId, opts = {}) {
  if (!cfg.clickupSyncEnabled && !opts.force) return { skipped: 'sync disabled' };
  const ctx = await loadPushContext(appId);
  if (!ctx) return { skipped: 'not found' };
  // HARD RULE: a file archived/deleted in the portal must NEVER be deleted or
  // deactivated in ClickUp — ClickUp stays the source of record. We simply do
  // not push deleted files (and there is no deleteTask path anywhere in the sync).
  if (ctx._row.deleted_at) return { skipped: 'portal-deleted (ClickUp left untouched)' };

  const taskId = ctx._row.clickup_pipeline_task_id || null;
  // GUARD (owner-directed 2026-07-15): a SCOPED push — the enqueue-on-write job a
  // field edit creates — may NEVER create a task. An unlinked file that should
  // have been linked (a lost/stolen binding) would otherwise silently spawn a
  // NEAR-DUPLICATE ClickUp task on the next edit. Task creation is reserved for
  // the explicit create-at-file-start (createForNewFile) and the admin repush,
  // both of which call without opts.only.
  const scopedRequested = Array.isArray(opts.only) && opts.only.length > 0;
  if (!taskId && scopedRequested) {
    await logSync('push_skipped_unlinked', appId, null, { only: opts.only.slice(0, 20) });
    return { skipped: 'unlinked file — a scoped push never creates a ClickUp task' };
  }
  const listId = taskId ? null : await resolveTargetList(ctx);
  const options = await registry.optionMap(listId || ctx._row.clickup_list_id).catch(() => ({}));
  const ysProgramFieldId = null; // set once the "YS Program" field is created + re-pulled
  const built = mapper.buildTaskFields(ctx, options, ysProgramFieldId);

  // Scoped push (SAFETY, post-incident): when the queue job names the specific
  // fields a staff edit changed (opts.only), push ONLY those custom fields — an
  // edit to one field can never rewrite the rest of the ClickUp task. A FULL
  // push happens only on task creation, or on an explicit resync (no opts.only,
  // e.g. the admin per-file "repush" button).
  const scoped = (taskId && Array.isArray(opts.only) && opts.only.length) ? mapper.resolveOnly(opts.only) : null;
  const fieldsToPush = scoped ? built.customFields.filter((c) => scoped.cuIds.has(c.id)) : built.customFields;
  const pushStatus = scoped ? scoped.status : true;
  // Checklist option-writes are appended ONLY for explicitly-scoped checklist
  // keys, and NEVER on create (built.customFields alone builds a new task). This
  // is the structural guarantee that a create/full-repush can't touch a ClickUp
  // checklist dropdown.
  const chosen = [...fieldsToPush];
  if (scoped && scoped.checklistFieldIds && scoped.checklistFieldIds.size) {
    for (const c of built.checklistFields) if (scoped.checklistFieldIds.has(c.id)) chosen.push(c);
  }

  let id = taskId;
  let journalStats = null;
  if (!id) {
    if (!listId) throw new Error('no target list for application ' + appId);
    circuitCheck(appId, null, built.customFields.length);   // creates count toward the volume breaker too
    const task = await clickup.createTask(listId, { name: built.name, status: built.statusName || undefined, custom_fields: built.customFields });
    id = task.id;
    // Journal the create as a full write (no before values — the task is new).
    for (const c of built.customFields) await journalFieldWrite(appId, id, c.id, undefined, c.value, 'create');
    await db.query(`UPDATE applications SET clickup_pipeline_task_id=$1, sync_state='linked', clickup_last_synced_at=now(), updated_at=now() WHERE id=$2`, [id, appId]);
  } else {
    // Field-by-field update (setField). Loop-safety on the subsequent inbound pull
    // of our own write is STRUCTURAL, not echo-based (see below): re-applying a
    // just-pushed value is an idempotent COALESCE no-op, and checklist statuses use
    // the no-downgrade/skip-equal rule — so there is no pull→push loop to suppress.
    //
    // GUARDRAILS (2026-07-15 DOB incident — see docs/CLICKUP-DATE-INCIDENT.md):
    //  1. Read the task ONCE before writing and SKIP any field whose ClickUp value
    //     is already equivalent — the sync never rewrites a field it isn't changing,
    //     so a conversion bug can no longer silently sweep values across the board.
    //  2. Every write that goes through is JOURNALED with the before value
    //     (clickup_write_log) — a complete, queryable API history of what the
    //     portal changed in ClickUp, which this incident lacked.
    //  3. The DOB-corruption signature (an AUTOMATED scoped push moving an
    //     existing DOB by exactly ±1 day) is REFUSED and audited loudly; only an
    //     explicit human-initiated full repush may apply such a change.
    let before = null;
    try {
      const t = await clickup.getTask(id);
      before = {};
      for (const c of (t && t.custom_fields) || []) before[c.id] = c.value;
      before.__status = t && t.status && (typeof t.status === 'object' ? t.status.status : t.status);
    } catch (e) {
      // FAIL CLOSED for queue-driven scoped pushes (owner-directed 2026-07-15):
      // without the before-image, neither the no-op suppression nor the DOB/PII
      // shields can evaluate — so a scoped push errors and the queue retries
      // with backoff instead of writing blind. An explicit admin full repush
      // (a human watching the response) keeps the previous warn-and-proceed.
      if (scoped) { e.message = 'pre-write read failed — failing closed for a scoped push (queue retries): ' + e.message; throw e; }
      console.warn('[clickup] pre-write read failed (full repush proceeds without no-op suppression):', e.message);
    }
    journalStats = { written: 0, suppressed: 0, blocked: 0 };
    let overwrites = 0;   // writes that REPLACED an existing ClickUp value (not fills)
    const source = scoped ? 'scoped_push' : 'full_repush';
    for (const c of chosen) {
      const old = before ? before[c.id] : undefined;
      if (before && fieldValueEquivalent(c.id, old, c.value, options)) { journalStats.suppressed++; continue; }
      if (scoped && !opts.approvedReview && isSuspectDobShift(c.id, old, c.value)) {
        journalStats.blocked++;
        console.error('[clickup] BLOCKED suspect DOB day-shift push', { appId, taskId: id, from: old, to: c.value });
        await journalFieldWrite(appId, id, c.id, old, c.value, source, { blocked: true });
        await logSync('dob_shift_blocked', appId, id, { fieldId: c.id, from: old != null ? String(old) : null, to: String(c.value) });
        // Surface the refusal in the staff "Sync review" queue — an approver can
        // apply it deliberately (approve → re-push with opts.approvedReview).
        await require('../lib/sync-review').queueReview({
          applicationId: appId, taskId: id, direction: 'outbound', fieldKey: 'date_of_birth',
          currentValue: T.fromEpochMs(old), proposedValue: T.fromEpochMs(c.value), rawValue: String(c.value),
          reason: 'dob_one_day_shift_blocked' });
        continue;
      }
      // PII OVERWRITE SHIELD (owner-directed 2026-07-15, layered on the DOB
      // guard above): a FULL repush may FILL a blank identity field on ClickUp
      // but never REWRITE a differing one — bulk pushes can no longer clobber
      // ClickUp-side borrower identity (SSN / email / phone / name / home
      // address). A deliberate portal edit of that exact field still flows: it
      // arrives as a SCOPED push carrying only that field (scoped pushes only
      // ever contain their own scoped fields, so they never trip this), and a
      // queued review's approval re-pushes with opts.approvedReview. DOB is
      // governed by the dedicated day-shift guard above, not this shield.
      const oldBlank = old == null || old === '' || (Array.isArray(old) && !old.length);
      if (!scoped && !opts.approvedReview && PII_OVERWRITE_SHIELD.has(c.id) && (before == null || !oldBlank)) {
        journalStats.blocked++;
        await journalFieldWrite(appId, id, c.id, old, c.value, source, { blocked: true });
        await logSync('pii_overwrite_blocked', appId, id, { fieldId: c.id, fieldKey: PII_REVIEW_KEY[c.id] || null });
        await require('../lib/sync-review').queueReview({
          applicationId: appId, taskId: id, direction: 'outbound', fieldKey: PII_REVIEW_KEY[c.id] || c.id,
          currentValue: reviewPreview(c.id, old), proposedValue: reviewPreview(c.id, c.value),
          rawValue: reviewPreview(c.id, c.value), reason: 'pii_overwrite_blocked' });
        continue;
      }
      try {
        circuitCheck(appId, id, 1);   // mass-write breaker (see below)
        if (!oldBlank && before != null) overwrites++;
        await clickup.setField(id, c.id, c.value);
        journalStats.written++;
        await journalFieldWrite(appId, id, c.id, old, c.value, source);
      } catch (e) {
        if (e && e.code === 'CLICKUP_CIRCUIT_OPEN') throw e;   // stop the whole push, queue retries later
        console.error('[clickup] setField failed', c.id, e.message);
      }
    }
    // OVERWRITE-STORM ALARM: one push rewriting many existing values is the
    // signature of the incident class (a wrong-file link / bulk clobber). Not
    // blocked — a legitimate admin repush after big portal edits exists — but
    // LOUD, so it can never happen silently again.
    if (overwrites > 10) {
      console.warn(`[clickup] OVERWRITE STORM: push rewrote ${overwrites} existing values on task ${id} (app ${appId})`);
      await logSync('push_overwrite_storm', appId, id, { overwrites, scoped: !!scoped });
    }
    if (pushStatus && built.statusName && (!before || before.__status !== built.statusName)) {
      try {
        await clickup.updateTask(id, { status: built.statusName });
        await journalFieldWrite(appId, id, null, before ? before.__status : undefined, built.statusName, source, { fieldKey: 'status' });
      } catch (_) {}
    }
    await db.query(`UPDATE applications SET clickup_last_synced_at=now(), updated_at=now() WHERE id=$1`, [appId]);
  }

  // NOTE (2026-07-12 audit — I-B): the former per-field "echo shadow" was removed.
  // It was write-only — inbound ingest never consulted it — so it gave a false
  // impression of an active loop guard while doing nothing. Loop-safety here is
  // achieved structurally instead: (1) inbound writes every column via
  // COALESCE(pulled, col), so re-applying our own pushed value is a no-op;
  // (2) checklist statuses use no-downgrade + skip-when-equal; (3) outbound is
  // scoped enqueue-on-write only (no dirty-sweep), so a pull never re-enqueues a
  // push. If a future NON-idempotent both-way field is added (pull value differs
  // from the pushed value), reintroduce a real, wired suppression at that point.
  await logSync('push', appId, id, { fields: chosen.length, scoped: !!scoped, ...(journalStats || {}) });
  return { taskId: id, fields: chosen.length, scoped: !!scoped, ...(journalStats || {}) };
}

// ---- write guardrails (2026-07-15 DOB incident) -----------------------------
// The pure checks (fieldValueEquivalent / isSuspectDobShift) live in mapper.js so
// they're unit-tested with the rest of the mapping core; this file only journals.
const T = require('./transforms');
const F = require('./fields');
const { fieldValueEquivalent, isSuspectDobShift } = mapper;
const MASKED_FIELDS = new Set([F.SHARED.borrowerSSN, F.EXTRA.card]);

// ---- PII overwrite shield (owner-directed 2026-07-15) -----------------------
// Borrower-IDENTITY fields a FULL repush may fill but never rewrite. DOB is
// deliberately NOT here — it has its own dedicated day-shift guard + review
// flow above (and the restore tooling applies approved DOBs via full repush).
const PII_OVERWRITE_SHIELD = new Set([
  F.SHARED.borrowerName, F.SHARED.borrowerSSN, F.SHARED.borrowerEmail,
  F.SHARED.borrowerCell, F.SHARED.borrowerAddress,
]);
// ClickUp field id → the logical key a sync-review APPROVAL re-pushes
// (resolveOnly maps each of these back to the exact ClickUp field).
const PII_REVIEW_KEY = {
  [F.SHARED.borrowerName]: 'first_name',
  [F.SHARED.borrowerSSN]: 'ssn',
  [F.SHARED.borrowerEmail]: 'email',
  [F.SHARED.borrowerCell]: 'cell_phone',
  [F.SHARED.borrowerAddress]: 'current_address',
};
// Short, SSN-masked preview for the review queue (display only — an approval
// re-pushes from the live DB, never from these strings).
function reviewPreview(fieldId, v) {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (fieldId === F.SHARED.borrowerSSN) return T.maskSSN(s);
  return s.slice(0, 120);
}

// ---- outbound volume circuit breaker (owner-directed 2026-07-15) ------------
// The ultimate anti-mass-write guard: no matter what upstream logic does, the
// integration cannot write more than CLICKUP_MAX_FIELD_WRITES_10MIN field
// values (default 300) in any rolling 10-minute window. Beyond the cap every
// push THROWS (queue jobs retry after backoff; an admin repush surfaces the
// error) and one loud audit row marks the circuit opening. Normal operation —
// scoped single-field edits, the occasional repush — never comes near the cap;
// only a runaway loop or a mass-clobber bug does, and that is exactly what
// must stop hard instead of continuing.
const CIRCUIT_WINDOW_MS = 10 * 60 * 1000;
const CIRCUIT_MAX_WRITES = Math.max(50, parseInt(process.env.CLICKUP_MAX_FIELD_WRITES_10MIN || '300', 10) || 300);
let _writeTimes = [];
let _circuitAudited = 0;
function circuitCheck(appId, taskId, n = 1) {
  const now = Date.now();
  if (_writeTimes.length > CIRCUIT_MAX_WRITES * 2) _writeTimes = _writeTimes.slice(-CIRCUIT_MAX_WRITES);
  _writeTimes = _writeTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  if (_writeTimes.length + n > CIRCUIT_MAX_WRITES) {
    if (now - _circuitAudited > 60 * 1000) {   // audit at most once a minute
      _circuitAudited = now;
      logSync('outbound_circuit_open', appId, taskId, { writesInWindow: _writeTimes.length, cap: CIRCUIT_MAX_WRITES }).catch(() => {});
      console.error(`[clickup] OUTBOUND CIRCUIT OPEN: ${_writeTimes.length} field writes in 10 min (cap ${CIRCUIT_MAX_WRITES}) — refusing further writes`);
    }
    const e = new Error(`ClickUp outbound circuit open (${_writeTimes.length} writes in 10 min, cap ${CIRCUIT_MAX_WRITES})`);
    e.code = 'CLICKUP_CIRCUIT_OPEN';
    throw e;
  }
  for (let i = 0; i < n; i++) _writeTimes.push(now);
}

/** Append-only journal of every ClickUp field write (before + after). PII rule:
 *  SSN / card values are masked before they land in the journal. Best-effort —
 *  a journal failure never blocks the push itself. */
async function journalFieldWrite(appId, taskId, fieldId, oldVal, newVal, source, extra = {}) {
  try {
    const mask = (v) => {
      if (v == null) return null;
      if (!MASKED_FIELDS.has(fieldId)) return v;
      if (fieldId === F.SHARED.borrowerSSN) return T.maskSSN(v);
      // Card field carries the JOINED line ("number  exp  cvv") — maskCard on the
      // raw line would keep the CVV as part of its "last 4" (pre-merge audit #1).
      // Parse first and mask the NUMBER only; exp/cvv never land in the journal.
      const parsed = T.parseCardLine(String(v));
      return parsed && parsed.number ? T.maskCard(parsed.number) : '✱✱✱✱ (card line)';
    };
    await db.query(
      `INSERT INTO clickup_write_log (application_id, task_id, field_id, field_key, old_value, new_value, changed, blocked, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [appId || null, String(taskId), fieldId, extra.fieldKey || null,
       oldVal === undefined ? null : JSON.stringify(mask(oldVal)),
       newVal === undefined ? null : JSON.stringify(mask(newVal)),
       !extra.blocked, !!extra.blocked, source || null]);
  } catch (e) { console.warn('[clickup] write-journal insert failed:', e.message); }
}

/** Resolve the destination list: officer's pipeline folder, else Lead Capture. */
async function resolveTargetList(ctx) {
  const route = routing.resolveRouting(ctx.officerName);
  const folderId = route.pipelineFolderId || routing.LEAD_CAPTURE_FOLDER;
  if (ctx._row.clickup_folder_id == null) {
    await db.query(`UPDATE applications SET clickup_folder_id=$1 WHERE id=$2`, [folderId, ctx.portalAppId]).catch(() => {});
  }
  return firstListId(folderId);
}

/** Best-effort activity-log row (masked; see PII policy). */
async function logSync(direction, appId, taskId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, $1, 'clickup', $2, $3)`,
      [`clickup_${direction}`, appId, JSON.stringify({ taskId, ...detail })]);
  } catch (_) { /* audit best-effort */ }
}

/**
 * Create + link a ClickUp task for a BRAND-NEW portal file at file-start (#92).
 * A portal-originated file used to land unlinked and only got a ClickUp task as a
 * side effect of the first later edit (or a manual admin repush). This wires the
 * create at creation time: it seeds the internal-status mirror to the pipeline's
 * first status ('starting' → borrower sees 'new'), then runs a full push. For an
 * unlinked file that resolves the target list (the officer's pipeline folder, or
 * Lead Capture when there's no/unknown officer) and creates the task. Best-effort
 * and idempotent (updates instead of duplicating if a task already exists), and
 * respects the clickupSyncEnabled master switch. Never deletes (hard rule).
 */
async function createForNewFile(appId) {
  try {
    await db.query(
      `UPDATE applications SET internal_status = COALESCE(internal_status, 'starting'), updated_at = now() WHERE id = $1`,
      [appId]);
  } catch (_) { /* seeding the mirror is best-effort */ }
  try {
    return await pushApplication(appId);
  } catch (e) {
    console.error('[clickup] createForNewFile push failed', appId, e && e.message);
    return { error: e && e.message };
  }
}

module.exports = {
  pushApplication, createForNewFile, loadPushContext, resolveTargetList, firstListId, logSync,
  PII_OVERWRITE_SHIELD, PII_REVIEW_KEY, // exported for the write-safety tests
};
