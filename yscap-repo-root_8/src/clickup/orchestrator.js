/**
 * Push orchestrator — portal → ClickUp. Glues the DB, the mapper, the live
 * option registry, echo-suppression, routing, and the REST client to create or
 * update a Pipeline task from a portal application. Pull/ingest lives in
 * ingest.js (shared with the backfill).
 *
 * Gated by cfg.clickupSyncEnabled; every call is a no-op when the master switch
 * is off, so this is safe to wire before go-live.
 */
const db = require('../db');
const cfg = require('../config');
const clickup = require('./client');
const registry = require('./registry');
const mapper = require('./mapper');
const echo = require('./echo');
const statusMap = require('./status');
const F = require('./fields');
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

  let id = taskId;
  if (!id) {
    if (!listId) throw new Error('no target list for application ' + appId);
    const task = await clickup.createTask(listId, { name: built.name, status: built.statusName || undefined, custom_fields: built.customFields });
    id = task.id;
    await db.query(`UPDATE applications SET clickup_pipeline_task_id=$1, sync_state='linked', clickup_last_synced_at=now(), updated_at=now() WHERE id=$2`, [id, appId]);
  } else {
    // field-by-field update (setField) so we can stamp echo per field
    for (const c of built.customFields) {
      try { await clickup.setField(id, c.id, c.value); echo.markPushed(id, c.id, c.value); }
      catch (e) { console.error('[clickup] setField failed', c.id, e.message); }
    }
    if (built.statusName) { try { await clickup.updateTask(id, { status: built.statusName }); } catch (_) {} }
    await db.query(`UPDATE applications SET clickup_last_synced_at=now(), updated_at=now() WHERE id=$1`, [appId]);
  }

  // Shadow the pushed values for echo comparison. NEVER store plaintext PII at
  // rest: SSN / appraisal-card values are replaced with a short salted hash so
  // the shadow is still comparable but carries no readable secret.
  const SENSITIVE = new Set([F.SHARED.borrowerSSN, F.EXTRA.card]);
  const hashVal = (v) => 'h:' + require('crypto').createHmac('sha256', cfg.ssnKey).update(String(v)).digest('hex').slice(0, 24);
  const shadow = {};
  for (const c of built.customFields) shadow[c.id] = SENSITIVE.has(c.id) ? hashVal(c.value) : c.value;
  await db.query(`UPDATE applications SET clickup_shadow=$1, clickup_shadow_hash=$2 WHERE id=$3`,
    [JSON.stringify(shadow), echo.shadowHash(shadow), appId]).catch(() => {});
  await logSync('push', appId, id, { fields: built.customFields.length });
  return { taskId: id, fields: built.customFields.length };
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

module.exports = { pushApplication, loadPushContext, resolveTargetList, firstListId, logSync };
