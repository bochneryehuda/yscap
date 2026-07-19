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
  } catch (err) {
    // The audit trail must never go dark silently — a real Sitewire write with no journal row
    // is a compliance hole. Warn loudly (the write itself already happened; we don't undo it).
    console.warn(`[sitewire] JOURNAL WRITE FAILED (Sitewire write proceeded, audit row missing) entity=${e.entity} field=${e.field}: ${db.describeError ? db.describeError(err) : err.message}`);
  }
}

// ---- park a stuck/ambiguous state for a human (never guess, never silently drop) ----
// `dedupe` differentiates DISTINCT failures that share a reason class (e.g. a bind failure on
// line A vs line B) so they don't collapse into one row and lose the second failure's detail.
async function park({ appId, reason, fieldKey = 'sitewire', current = null, proposed = null, dedupe = null }) {
  const cls = String(reason).split(':')[0];
  // The shared open-review unique index is (COALESCE(task_id,''), field_key, direction,
  // COALESCE(proposed_value,'')) and does NOT include application_id. Stamp a per-(file,
  // reason-class, instance) key into task_id (no FK; unused by sitewire rows) so distinct
  // files / reasons / instances never collide on the index and none is silently swallowed.
  const taskKey = `sitewire:${appId}:${cls}${dedupe ? ':' + String(dedupe).slice(0, 80) : ''}`;
  try {
    const existing = await db.query(
      `SELECT id FROM sync_review_queue WHERE task_id=$1 AND field_key=$2 AND status='open' LIMIT 1`, [taskKey, fieldKey]);
    if (existing.rowCount > 0) return existing.rows[0].id;
    const r = await db.query(
      `INSERT INTO sync_review_queue (application_id, task_id, direction, field_key, current_value, proposed_value, reason, status)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,'open') RETURNING id`,
      [appId, taskKey, fieldKey, current == null ? null : String(current), proposed == null ? null : String(proposed), reason]);
    const rid = r.rows[0].id;
    try { await require('../lib/sync-review').notifyLoanOfficer(rid); } catch (_) {}
    return rid;
  } catch (err) {
    // A concurrent insert may have raced us to the same task_id — return THAT row rather than
    // letting this park vanish (the unique-index collision must never silently drop a review).
    try { const ex = await db.query(`SELECT id FROM sync_review_queue WHERE task_id=$1 AND field_key=$2 AND status='open' LIMIT 1`, [taskKey, fieldKey]); if (ex.rowCount) return ex.rows[0].id; } catch (_) {}
    console.warn(`[sitewire] PARK FAILED to record a review row (app=${appId}, reason="${reason}"): ${db.describeError ? db.describeError(err) : err.message}`);
    return null;
  }
}

// ---- rolling 10-minute volume circuit breaker (shared across every write path) ----
async function circuitCheck(n = 1) {
  let r;
  try {
    r = await db.query(`SELECT count(*)::int AS c FROM sitewire_write_log WHERE created_at > now() - interval '10 minutes' AND blocked=false`);
  } catch (err) {
    // Fail CLOSED: if we can't read the breaker counter we must NOT let the write proceed
    // unguarded (a runaway during DB trouble could otherwise bypass the cap). Throw retryable
    // so the durable queue re-attempts once the DB recovers.
    const e = new Error(`SITEWIRE_CIRCUIT_CHECK_FAILED: ${db.describeError ? db.describeError(err) : err.message}`);
    e.retryable = true; throw e;
  }
  if ((r.rows[0].c + n) > cfg.sitewireMaxWrites10min) {
    const e = new Error(`SITEWIRE_CIRCUIT_OPEN: >${cfg.sitewireMaxWrites10min} writes/10min`);
    e.code = 'SITEWIRE_CIRCUIT_OPEN'; throw e;
  }
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
  // A fuzzy substring match is NOT auto-bound (that would be a guess — owner's #1 rule). A
  // single close match is surfaced as a CANDIDATE so the push parks it for one-click human
  // confirmation instead of silently binding "Capital" → "RCN Capital".
  const contains = rows.filter((r) => { const n = norm(r.name); return n.includes(L) || L.includes(n); });
  if (contains.length === 1) return { id: null, ambiguous: false, candidate: contains[0].sitewire_id, candidateName: contains[0].name };
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
            b.email AS borrower_email, l.llc_name,
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

// Resolve the inspection method for a file: the coordinator's per-file choice (link.inspection_method)
// if set, else the rule's DEFAULT (auto virtual/physical). The choice is validated against what the
// rule ALLOWS — a stored method the rule no longer allows falls back to an allowed one (never a
// method the capital partner forbids). Returns { method, feeKind, feeCents, allowVirtual, allowPhysical }.
function resolveInspection(link, rule) {
  const dflt = (rule && rule.inspection_method) || 'mobile';
  const allowVirtual = !rule || rule.allow_virtual !== false;
  const allowPhysical = !rule || rule.allow_physical !== false;
  let method = (link && link.inspection_method) || dflt;
  if (method === 'mobile' && !allowVirtual) method = allowPhysical ? 'traditional' : dflt;
  if (method === 'traditional' && !allowPhysical) method = allowVirtual ? 'mobile' : dflt;
  const feeKind = T.feeKindFor(method);
  const feeCents = rule ? (feeKind === 'physical' ? (rule.fee_cents_physical != null ? rule.fee_cents_physical : rule.fee_cents_virtual) : rule.fee_cents_virtual) : 29900;
  return { method, feeKind, feeCents, allowVirtual, allowPhysical };
}

/**
 * Birth push for a funded file. Returns { ok, skipped?, parked?, propertyId?, budgetId? }.
 * force=true bypasses the master switch (used by an admin manual push, still guarded).
 */
async function pushFile(appId, opts = {}) {
  if (!cfg.sitewireEnabled && !opts.force) return { skipped: 'sitewire disabled' };
  // The write gate is NOT bypassable by force (staging safety) — only dry-run lets a
  // push proceed with writes off (it validates the bodies + logs, sends nothing).
  if (!cfg.sitewireOutboundEnabled && !cfg.sitewireDryrun) return { skipped: 'sitewire outbound disabled (set SITEWIRE_OUTBOUND_ENABLED=1 or SITEWIRE_DRYRUN=1)' };
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

  // G-UNITS: the property's unit count (from the file) must match the Scope of Work's unit count.
  // We send total_units from the file but explode the budget from the SOW — if they disagree, Sitewire
  // would show a unit total that doesn't match its per-unit budget lines. Never guess which is right — park.
  if (a.units != null && Number(a.units) > 0) {
    const sowUnits = M.unitCount(a.sow_payload.state);
    if (Number(a.units) !== sowUnits) {
      await park({ appId, reason: `sitewire_units_mismatch: the file says ${Number(a.units)} unit(s) but the Scope of Work is built for ${sowUnits} — reconcile them before pushing (Sitewire's unit count must match its budget lines)`, current: String(a.units), proposed: String(sowUnits) });
      return { parked: 'units_mismatch' };
    }
  }

  // explode + G-RECON (must tie to the frozen budget to the cent BEFORE any write)
  const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
  // absorb ≤$1 percentage-rounding drift into contingency/GC so a validly signed-off SOW
  // isn't wrongly parked (audit S4); a real mismatch beyond tolerance still blocks below.
  const ex = M.reconcileToBudget(M.explodeSow(a.sow_payload.state, {}), budgetCents);
  M.uniquifyNames(ex.items); // re-dedupe: reconcileToBudget may append a 'Contingency' line after the first pass
  if (ex.total_cents !== budgetCents) {
    await park({ appId, reason: `sitewire_budget_mismatch: exploded SOW total ${T.usd(ex.total_cents)} != frozen budget ${T.usd(budgetCents)}`, current: budgetCents, proposed: ex.total_cents });
    return { parked: 'budget_mismatch' };
  }

  // resolve capital partner (G-CP) + rule + coordinator
  const cp = await resolveCapitalPartnerId(a.lender);
  if (!cp.id) {
    const why = cp.candidate ? `partially matched "${cp.candidateName}" — confirm it's the right partner` : `${cp.ambiguous ? 'matched multiple' : 'matched no'} Sitewire capital partner`;
    await park({ appId, reason: `sitewire_capital_partner_unmatched: lender label "${a.lender || '(blank)'}" ${why}`, current: a.lender, proposed: cp.candidate ? String(cp.candidate) : null });
    return { parked: 'capital_partner' };
  }
  const rule = await resolveRule(cp.id, program);
  // method = coordinator's per-file choice ?? rule default, validated against what the rule allows
  const existingLink = await getLink(appId);
  const insp = resolveInspection(existingLink, rule);
  const inspectionMethod = insp.method;
  const feeCents = insp.feeCents;
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
    capital_partner_id: Number(cp.id),                 // pg bigint -> number (Sitewire expects an integer)
    inspection_method: inspectionMethod,
    require_sitewire_inspector: !!(rule && rule.require_sitewire_inspector),
    require_capital_partner_approval: !!(rule && rule.require_capital_partner_approval),
    allow_reallocation: !!(rule && rule.allow_reallocation),
    processing_fee_cents: Number(feeCents),
    default_draw_coordinator_id: coordinatorId != null ? Number(coordinatorId) : null,
    draw_checklist_template_id: cfg.sitewireDefaultChecklistTemplateId,
    address: addr,
  };
  // never send a null field (guardNoUnsafeWrite rejects clearing values) — omit instead
  if (propertyFields.default_draw_coordinator_id == null) delete propertyFields.default_draw_coordinator_id;
  if (a.units) propertyFields.total_units = Number(a.units);
  if (devType) propertyFields.development_type = devType;
  if (consType) propertyFields.construction_type = consType;
  // G-ENUM: a property/construction type we couldn't map is LEFT BLANK (never guessed) — but raise
  // an advisory review so someone sets it in Sitewire, rather than it silently going unset. Non-blocking
  // (the push still proceeds — these are optional Sitewire fields); deduped so it can't spam the queue.
  if (a.property_type && !devType) await park({ appId, reason: `sitewire_type_unmapped: property type "${a.property_type}" didn't map to a Sitewire development_type — left blank, set it in Sitewire if needed`, dedupe: 'devtype' });
  if ((a.loan_type || a.rehab_type) && !consType) await park({ appId, reason: `sitewire_type_unmapped: loan/rehab type "${a.loan_type || ''}/${a.rehab_type || ''}" didn't map to a Sitewire construction_type — left blank, set it in Sitewire if needed`, dedupe: 'construction' });
  if (a.llc_name) propertyFields.borrower_entity_name = a.llc_name;

  let link = existingLink;

  // G-DUPEPROP: if not linked and a Sitewire property already carries our loan number, park (never adopt/duplicate)
  if (!link || !link.sitewire_property_id) {
    let existing = null;
    try {
      const all = await client.listProperties();
      existing = (all || []).find((p) => String(p.loan_number || '') === String(a.ys_loan_number));
    } catch (e) {
      if (e.retryable) throw e; // transient → the queue retries the whole push
      // A NON-retryable failure of the dupe check must NEVER fall through to create — that
      // would risk a duplicate property (violating only-ours). Park instead of guessing safe.
      await park({ appId, reason: `sitewire_dupe_check_failed: could not verify loan ${a.ys_loan_number} isn't already in Sitewire (${e.message}) — not creating, to avoid a duplicate` });
      return { parked: 'dupe_check_failed' };
    }
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
  const propertyId = property && property.id;
  const budgetId = property && property.budget && property.budget.id;
  // A 200 that came back without the ids we need to bind the crosswalk is NOT a success — never
  // proceed with undefined ids or write a link row we can't reconcile (G-RAW / E-RAW-NOID).
  if (!propertyId || !budgetId) {
    await park({ appId, reason: `sitewire_bind_missing_property: Sitewire returned a property with no ${propertyId ? 'budget id' : 'property id'} — cannot bind. Response: ${JSON.stringify(property || {}).slice(0, 200)}` });
    return { parked: 'no_ids' };
  }
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

  // Sitewire LOCKS a line's name once a draw references it — renaming it 422s the WHOLE budget
  // PATCH, which would block unrelated cents changes batched in the same push (audit M2). So a line
  // that already has a draw request is re-budgeted but NEVER renamed (the cents change still goes;
  // only the cosmetic rename is skipped). Look up the drawn job-item ids once.
  const drawn = new Set((await db.query(
    `SELECT DISTINCT r.sitewire_job_item_id FROM sitewire_draw_requests r
       JOIN sitewire_draws d ON d.sitewire_draw_id = r.sitewire_draw_id
      WHERE d.application_id=$1 AND r.sitewire_job_item_id IS NOT NULL`, [appId])).rows.map((x) => Number(x.sitewire_job_item_id)));

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
    // rename only if changed AND the line isn't locked by an existing draw (else Sitewire 422s the batch)
    if ((u.prev_name || '') !== (u.name || '') && !drawn.has(Number(u.sitewire_job_item_id))) ji.name = u.name;
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

  // capture ids (G-BIND). A NEW line binds to the response item with its unique name. A line that
  // was ALREADY bound (update/unchanged) keeps its KNOWN id — we must NOT re-find it by name, because
  // a rename suppressed on a drawn line (M2) makes Sitewire echo the OLD name, which the desired-name
  // lookup would miss (false "bind_missing" + stale crosswalk cents). For those we refresh cents by id
  // and store the name Sitewire actually holds (old name when the rename was suppressed, else the new).
  const respByName = new Map();
  for (const ji of (updated.job_items || [])) {
    if (!respByName.has(ji.name)) respByName.set(ji.name, ji);
    else respByName.set(ji.name, null); // duplicate name -> ambiguous
  }
  const linkByKey = new Map();
  for (const l of links) linkByKey.set(`${l.sow_line_key} ${l.section_token}`, l);
  for (const c of ex.items) {
    const existing = linkByKey.get(`${c.sow_line_key} ${c.section_token}`);
    let jiId, storedName;
    if (existing && existing.sitewire_job_item_id != null) {
      jiId = existing.sitewire_job_item_id;
      const renameSuppressed = drawn.has(Number(jiId)) && (existing.name || '') !== (c.name || '');
      storedName = renameSuppressed ? existing.name : c.name; // match what Sitewire actually holds
    } else {
      const ji = respByName.get(c.name);
      if (ji === undefined) { await park({ appId, reason: `sitewire_bind_missing: created line "${c.name}" not found in response — cannot bind id`, dedupe: c.name }); continue; }
      if (ji === null) { await park({ appId, reason: `sitewire_bind_ambiguous: line name "${c.name}" appears twice — cannot bind id`, dedupe: c.name }); continue; }
      jiId = ji.id; storedName = c.name;
    }
    await db.query(
      `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sow_line_key, section_token, unit_index, sitewire_job_item_id, name, budgeted_cents, is_media_item, state, last_response_hash, last_pushed_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'live',$10,now(),now())
       ON CONFLICT (application_id, sow_line_key, section_token) DO UPDATE SET sitewire_job_item_id=EXCLUDED.sitewire_job_item_id, name=EXCLUDED.name, budgeted_cents=EXCLUDED.budgeted_cents, is_media_item=EXCLUDED.is_media_item, state='live', last_response_hash=EXCLUDED.last_response_hash, last_pushed_at=now(), updated_at=now()`,
      [appId, budgetId, c.sow_line_key, c.section_token, c.unit_index, jiId, storedName, c.budgeted_cents, !!c.is_media_item, T.stableHash({ n: storedName, b: c.budgeted_cents })]);
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
  } catch (e) {
    // If we can't confirm the write persisted, do NOT report success silently (there is no
    // budget re-verify in the reconcile poll to catch it later). Park it for a human to confirm.
    await park({ appId, reason: `sitewire_total_unverified: could not re-read the Sitewire budget to confirm it saved (${e.message}) — needs a manual check`, current: budgetId });
    return { parked: 'verify_failed' };
  }
  return { ok: true, created: diff.creates.length, updated: diff.updates.length, deleted: diff.deletes.length };
}

module.exports = { pushFile, pushBudget, park, journal, circuitCheck, resolveCapitalPartnerId, resolveRule, resolveInspection, resolveCoordinatorId, getLink, loadFile };
