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
  if (!id) {
    if (!listId) throw new Error('no target list for application ' + appId);
    const task = await clickup.createTask(listId, { name: built.name, status: built.statusName || undefined, custom_fields: built.customFields });
    id = task.id;
    await db.query(`UPDATE applications SET clickup_pipeline_task_id=$1, sync_state='linked', clickup_last_synced_at=now(), updated_at=now() WHERE id=$2`, [id, appId]);
  } else {
    // Field-by-field update (setField). Loop-safety on the subsequent inbound pull
    // of our own write is STRUCTURAL, not echo-based (see below): re-applying a
    // just-pushed value is an idempotent COALESCE no-op, and checklist statuses use
    // the no-downgrade/skip-equal rule — so there is no pull→push loop to suppress.
    for (const c of chosen) {
      try { await clickup.setField(id, c.id, c.value); }
      catch (e) { console.error('[clickup] setField failed', c.id, e.message); }
    }
    if (pushStatus && built.statusName) { try { await clickup.updateTask(id, { status: built.statusName }); } catch (_) {} }
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
  await logSync('push', appId, id, { fields: chosen.length, scoped: !!scoped });
  return { taskId: id, fields: chosen.length, scoped: !!scoped };
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

module.exports = { pushApplication, createForNewFile, loadPushContext, resolveTargetList, firstListId, logSync };
