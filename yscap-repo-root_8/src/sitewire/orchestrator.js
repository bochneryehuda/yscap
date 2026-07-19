'use strict';
/**
 * Sitewire push orchestrator — the guarded, journaled, idempotent path that creates a
 * PILOT-managed property + budget in Sitewire on the funded + Request-a-draw click.
 *
 * Invariants enforced at write time (research doc §11.3), never clamped:
 *   · Σ exploded job items == frozen rehab_budget (G-RECON) — else BLOCK + park.
 *   · a cell already bound to a Sitewire id becomes an UPDATE, never a 2nd create (idempotent).
 *   · read-after-write: re-GET the budget and assert the total persisted (G-RAW).
 * Guards park in sync_review_queue instead of guessing; every write is journaled to
 * sitewire_write_log; a rolling volume circuit breaker stops runaways.
 *
 * PILOT manages ONLY what it creates (only-ours rule): before creating a property we
 * check for a loan-number collision with the pre-existing Sitewire back-catalog and
 * park it (G-DUPEPROP) rather than duplicate or adopt.
 */
const db = require('../db');
const cfg = require('../config');
const client = require('./client');
const T = require('./transforms');
const M = require('./mapper');
const rehab = require('../lib/rehab-budget');

// ---- journal every write (before/after) ----
async function journal(e) {
  try {
    await db.query(
      `INSERT INTO sitewire_write_log (application_id, sitewire_property_id, sitewire_budget_id, entity, entity_id, idempotency_key, field, old_value, new_value, changed, blocked, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [e.appId || null, e.propertyId || null, e.budgetId || null, e.entity || null, e.entityId || null,
       e.idem || null, e.field || null, e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
       e.newValue === undefined ? null : JSON.stringify(e.newValue), e.changed !== false, !!e.blocked, e.source || 'push']);
  } catch (_) { /* journaling is best-effort but should rarely fail */ }
}

// ---- park a stuck/ambiguous state for a human (never guess) ----
async function park({ appId, reason, fieldKey = 'sitewire', current = null, proposed = null }) {
  try {
    // dedupe: one open row per (appId, reason)
    const existing = await db.query(
      `SELECT id FROM sync_review_queue WHERE application_id=$1 AND field_key=$2 AND reason LIKE $3 AND status='open' LIMIT 1`,
      [appId, fieldKey, reason.split(':')[0] + '%']);
    if (existing.rowCount > 0) return existing.rows[0].id;
    const r = await db.query(
      `INSERT INTO sync_review_queue (application_id, direction, field_key, current_value, proposed_value, reason, status)
       VALUES ($1,'outbound',$2,$3,$4,$5,'open') RETURNING id`,
      [appId, fieldKey, current == null ? null : String(current), proposed == null ? null : String(proposed), reason]);
    return r.rows[0].id;
  } catch (_) { return null; }
}

// ---- rolling 10-minute volume circuit breaker (shared across every write path) ----
async function circuitCheck(n = 1) {
  try {
    const r = await db.query(`SELECT count(*)::int AS c FROM sitewire_write_log WHERE created_at > now() - interval '10 minutes' AND blocked=false`);
    if ((r.rows[0].c + n) > cfg.sitewireMaxWrites10min) {
      const e = new Error(`SITEWIRE_CIRCUIT_OPEN: >${cfg.sitewireMaxWrites10min} writes/10min`);
      e.code = 'SITEWIRE_CIRCUIT_OPEN'; throw e;
    }
  } catch (e) { if (e.code === 'SITEWIRE_CIRCUIT_OPEN') throw e; }
}

// ---- resolve the capital-partner id from our free-text lender label (G-CP) ----
async function resolveCapitalPartnerId(lenderLabel) {
  const label = String(lenderLabel || '').trim();
  if (!label) return { id: null, ambiguous: false };
  const rows = (await db.query(`SELECT sitewire_id, name FROM sitewire_capital_partners`)).rows;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const L = norm(label);
  const exact = rows.filter((r) => norm(r.name) === L);
  if (exact.length === 1) return { id: exact[0].sitewire_id, ambiguous: false };
  const contains = rows.filter((r) => { const n = norm(r.name); return n.includes(L) || L.includes(n); });
  if (contains.length === 1) return { id: contains[0].sitewire_id, ambiguous: false };
  return { id: null, ambiguous: contains.length > 1 };
}

// ---- resolve the inspection + fee rule (partner+program -> partner -> global default) ----
async function resolveRule(capitalPartnerId, program) {
  const rows = (await db.query(`SELECT * FROM sitewire_inspection_rules`)).rows;
  const pick = (cp, pg) => rows.find((r) => (r.capital_partner_id == cp) && ((r.program || null) === (pg || null)));
  return pick(capitalPartnerId, program) || pick(capitalPartnerId, null) || pick(null, null) || null;
}

// ---- the draw coordinator's Sitewire user id (default Lisa Katz) ----
async function resolveCoordinatorId() {
  try {
    const r = await db.query(`SELECT sitewire_user_id FROM staff_users WHERE sitewire_user_id IS NOT NULL AND is_active ORDER BY updated_at DESC LIMIT 1`);
    // Phase 1: default coordinator id from config; a per-file override arrives later.
    return cfg.sitewireDefaultCoordinatorId || (r.rows[0] && r.rows[0].sitewire_user_id) || null;
  } catch (_) { return cfg.sitewireDefaultCoordinatorId || null; }
}

// ---- load the file + its SOW payload ----
async function loadFile(appId) {
  const a = (await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, a.property_type, a.loan_type, a.rehab_type,
            a.units, a.lender, a.status, a.actual_closing, a.borrower_id,
            b.email AS borrower_email, l.entity_name, l.llc_name,
            pr.program AS registered_program
       FROM applications a
       LEFT JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current
      WHERE a.id=$1 AND a.deleted_at IS NULL`, [appId])).rows[0];
  if (!a) return null;
  const sow = (await db.query(
    `SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' ORDER BY created_at LIMIT 1`, [appId])).rows[0];
  a.sow_payload = sow ? sow.tool_payload : null;
  return a;
}

async function getLink(appId) {
  return (await db.query(`SELECT * FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0] || null;
}

/**
 * Birth push for a funded file. Returns { ok, skipped?, parked?, propertyId?, budgetId? }.
 * force=true bypasses the master switch (used by an admin manual push, still guarded).
 */
async function pushFile(appId, opts = {}) {
  if (!cfg.sitewireEnabled && !opts.force) return { skipped: 'sitewire disabled' };
  if (!cfg.sitewireOutboundEnabled && !opts.force) return { skipped: 'sitewire outbound disabled' };
  const a = await loadFile(appId);
  if (!a) return { skipped: 'file not found/deleted' };
  if (a.status !== 'funded' && !opts.allowUnfunded) return { skipped: 'file not funded' };

  // G-LOAN
  if (!a.ys_loan_number) { await park({ appId, reason: 'sitewire_missing_loan_number: file has no YS loan number to push' }); return { parked: 'missing_loan_number' }; }

  // required frozen budget (the reconcile target)
  const budgetDollars = await rehab.requiredRehabBudget(appId);
  if (budgetDollars == null || Number(budgetDollars) <= 0) { await park({ appId, reason: 'sitewire_no_budget: no frozen rehab budget set — register the product first' }); return { parked: 'no_budget' }; }
  const budgetCents = Math.round(Number(budgetDollars) * 100);
  if (!a.sow_payload || !a.sow_payload.state) { await park({ appId, reason: 'sitewire_no_sow: no Scope of Work saved to explode into a budget' }); return { parked: 'no_sow' }; }

  // explode + G-RECON (must tie to the frozen budget to the cent BEFORE any write)
  const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
  const ex = M.explodeSow(a.sow_payload.state, {});
  if (ex.total_cents !== budgetCents) {
    await park({ appId, reason: `sitewire_budget_mismatch: exploded SOW total ${T.usd(ex.total_cents)} != frozen budget ${T.usd(budgetCents)}`, current: budgetCents, proposed: ex.total_cents });
    return { parked: 'budget_mismatch' };
  }

  // resolve capital partner (G-CP) + rule + coordinator
  const cp = await resolveCapitalPartnerId(a.lender);
  if (!cp.id) { await park({ appId, reason: `sitewire_capital_partner_unmatched: lender label "${a.lender || '(blank)'}" ${cp.ambiguous ? 'matched multiple' : 'matched no'} Sitewire capital partner`, current: a.lender }); return { parked: 'capital_partner' }; }
  const rule = await resolveRule(cp.id, program);
  const inspectionMethod = (rule && rule.inspection_method) || 'mobile';
  const feeKind = T.feeKindFor(inspectionMethod);
  const feeCents = rule ? (feeKind === 'physical' ? (rule.fee_cents_physical != null ? rule.fee_cents_physical : rule.fee_cents_virtual) : rule.fee_cents_virtual) : 29900;
  const coordinatorId = await resolveCoordinatorId();

  // address (G-ADDR handled by catching Sitewire's 422 below)
  const addr = T.addressForSitewire(a.property_address);
  if (!addr || !addr.street || !addr.city || !addr.state || !addr.zip) {
    await park({ appId, reason: 'sitewire_address_incomplete: property address is missing street/city/state/zip', current: JSON.stringify(a.property_address || {}) });
    return { parked: 'address' };
  }
  const devType = T.developmentType(a.property_type);
  const consType = T.constructionType(a.loan_type, a.rehab_type);

  const propertyFields = {
    loan_number: a.ys_loan_number,
    capital_partner_id: cp.id,
    inspection_method: inspectionMethod,
    require_sitewire_inspector: !!(rule && rule.require_sitewire_inspector),
    require_capital_partner_approval: !!(rule && rule.require_capital_partner_approval),
    allow_reallocation: !!(rule && rule.allow_reallocation),
    processing_fee_cents: feeCents,
    default_draw_coordinator_id: coordinatorId,
    draw_checklist_template_id: cfg.sitewireDefaultChecklistTemplateId,
    total_units: a.units || null,
    address: addr,
  };
  if (devType) propertyFields.development_type = devType;
  if (consType) propertyFields.construction_type = consType;
  if (a.entity_name || a.llc_name) propertyFields.borrower_entity_name = a.entity_name || a.llc_name;

  let link = await getLink(appId);

  // G-DUPEPROP: if not linked and a Sitewire property already carries our loan number, park (never adopt/duplicate)
  if (!link || !link.sitewire_property_id) {
    let existing = null;
    try {
      const all = await client.listProperties();
      existing = (all || []).find((p) => String(p.loan_number || '') === String(a.ys_loan_number));
    } catch (e) { if (e.retryable) throw e; }
    if (existing) {
      await park({ appId, reason: `sitewire_loan_already_in_sitewire: loan ${a.ys_loan_number} already exists in Sitewire (property ${existing.id}) — PILOT will not duplicate or adopt it`, current: String(existing.id) });
      return { parked: 'dupe_property' };
    }
  }

  await circuitCheck(1);
  let property;
  try {
    if (link && link.sitewire_property_id) {
      property = await client.updateProperty(link.sitewire_property_id, propertyFields);
    } else {
      property = await client.createProperty(propertyFields);
    }
  } catch (e) {
    if (e.status === 422) { await park({ appId, reason: `sitewire_property_rejected: Sitewire rejected the property (likely address geocode) — ${JSON.stringify(e.body || {}).slice(0, 200)}` }); return { parked: 'property_422' }; }
    throw e; // transient -> queue retries
  }
  if (property && property.__dryrun) return { dryrun: true, stage: 'property' };
  const propertyId = property.id;
  const budgetId = property.budget && property.budget.id;
  await journal({ appId, propertyId, budgetId, entity: 'property', entityId: propertyId, field: 'property', newValue: propertyFields, source: link ? 'push' : 'create' });

  // upsert the link
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, sitewire_budget_id, capital_partner_id, matched_by, state, pushed_at, raw, updated_at)
     VALUES ($1,$2,$3,$4,'created','live',now(),$5,now())
     ON CONFLICT (application_id) DO UPDATE SET sitewire_property_id=EXCLUDED.sitewire_property_id, sitewire_budget_id=EXCLUDED.sitewire_budget_id, capital_partner_id=EXCLUDED.capital_partner_id, state='live', pushed_at=now(), updated_at=now()`,
    [appId, propertyId, budgetId, cp.id, JSON.stringify({ inspectionMethod, feeCents })]);
  link = await getLink(appId);

  // assign borrower (best-effort; parks on 422)
  if (a.borrower_email) {
    try {
      const res = await client.assignBorrower(propertyId, a.borrower_email);
      if (!(res && res.__dryrun)) await journal({ appId, propertyId, entity: 'borrower', field: 'contact_email', newValue: a.borrower_email, source: 'push' });
    } catch (e) {
      if (e.status === 422 || e.status === 400) await park({ appId, reason: `sitewire_borrower_assign_failed: could not assign borrower ${a.borrower_email}` });
      else if (e.retryable) throw e;
    }
  }

  // push the budget/job-items via the crosswalk
  const budgetResult = await pushBudget(appId, budgetId, ex, budgetCents);
  return { ok: true, propertyId, budgetId, budget: budgetResult };
}

/**
 * Push the exploded budget through the crosswalk (create/update/delete), capture ids by
 * unique name, journal, and read-after-write verify the total (G-RAW/G-RECON).
 */
async function pushBudget(appId, budgetId, ex, budgetCents) {
  const links = (await db.query(
    `SELECT id, sow_line_key, section_token, sitewire_job_item_id, budgeted_cents, name FROM sitewire_job_item_links WHERE application_id=$1 AND sitewire_budget_id=$2`,
    [appId, budgetId])).rows;
  const diff = M.diffBudget(ex.items, links);

  // build the PATCH job_items array (creates: no id; updates: id+fields; deletes: id+_destroy)
  const job_items = [];
  for (const c of diff.creates) {
    const ji = { name: c.name, budgeted_cents: c.budgeted_cents };
    if (c.required_image_count != null) ji.required_image_count = c.required_image_count;
    if (c.required_video_count != null) ji.required_video_count = c.required_video_count;
    if (c.mandatory) ji.mandatory = true;
    job_items.push(ji);
  }
  for (const u of diff.updates) {
    const ji = { id: u.sitewire_job_item_id, budgeted_cents: u.budgeted_cents };
    if ((u.prev_name || '') !== (u.name || '')) ji.name = u.name; // rename only if changed (locked after a draw)
    job_items.push(ji);
  }
  for (const d of diff.deletes) job_items.push({ id: d.sitewire_job_item_id, _destroy: true });

  if (!job_items.length) return { unchanged: true };
  await circuitCheck(job_items.length);

  let updated;
  try {
    updated = await client.updateBudget(budgetId, { job_items, draw_eligible: true, funding_ratio: 100, funding_threshold_cents: 0 });
  } catch (e) {
    if (e.status === 422) { await park({ appId, reason: `sitewire_budget_rejected: ${JSON.stringify(e.body || {}).slice(0, 220)}` }); return { parked: 'budget_422' }; }
    throw e;
  }
  if (updated && updated.__dryrun) return { dryrun: true, wouldSend: job_items.length };

  // capture ids: bind each desired cell to the response item with the SAME unique name (G-BIND)
  const respByName = new Map();
  for (const ji of (updated.job_items || [])) {
    if (!respByName.has(ji.name)) respByName.set(ji.name, ji);
    else respByName.set(ji.name, null); // duplicate name -> ambiguous
  }
  for (const c of ex.items) {
    const ji = respByName.get(c.name);
    if (ji === undefined) { await park({ appId, reason: `sitewire_bind_missing: created line "${c.name}" not found in response — cannot bind id` }); continue; }
    if (ji === null) { await park({ appId, reason: `sitewire_bind_ambiguous: line name "${c.name}" appears twice — cannot bind id` }); continue; }
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sow_line_key, section_token, unit_index, sitewire_job_item_id, name, budgeted_cents, is_media_item, state, last_response_hash, last_pushed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'live',$10,now(),now())
       ON CONFLICT (application_id, sow_line_key, section_token) DO UPDATE SET sitewire_job_item_id=EXCLUDED.sitewire_job_item_id, name=EXCLUDED.name, budgeted_cents=EXCLUDED.budgeted_cents, is_media_item=EXCLUDED.is_media_item, state='live', last_response_hash=EXCLUDED.last_response_hash, last_pushed_at=now(), updated_at=now()`,
      [appId, budgetId, c.sow_line_key, c.section_token, c.unit_index, ji.id, c.name, c.budgeted_cents, !!c.is_media_item, T.stableHash({ n: ji.name, b: ji.budgeted_cents })]);
  }
  // process deletes in the crosswalk
  for (const d of diff.deletes) await db.query(`UPDATE sitewire_job_item_links SET state='deleted', updated_at=now() WHERE id=$1`, [d.id]);
  await journal({ appId, budgetId, entity: 'budget', entityId: budgetId, field: 'job_items', newValue: { creates: diff.creates.length, updates: diff.updates.length, deletes: diff.deletes.length }, source: 'push' });

  // read-after-write (G-RAW): re-GET and assert the total persisted to the cent
  try {
    const fresh = await client.getBudget(budgetId);
    if (fresh && fresh.total_budgeted_cents != null && Number(fresh.total_budgeted_cents) !== budgetCents) {
      await park({ appId, reason: `sitewire_total_drift: Sitewire budget total ${T.usd(fresh.total_budgeted_cents)} != expected ${T.usd(budgetCents)} after write`, current: fresh.total_budgeted_cents, proposed: budgetCents });
      return { parked: 'total_drift' };
    }
  } catch (_) { /* verify is best-effort; reconcile re-checks */ }
  return { ok: true, created: diff.creates.length, updated: diff.updates.length, deleted: diff.deletes.length };
}

module.exports = { pushFile, pushBudget, park, journal, circuitCheck, resolveCapitalPartnerId, resolveRule, loadFile };
