'use strict';

/**
 * The Condition Center engine.
 *
 * Watches the file's data and keeps rule-driven condition templates in sync:
 *
 *   evaluateApplication(appId)  — the core pass. Loads the file's rule context
 *     (applications + borrower + entity + registered product + verified
 *     experience), then for every active template with auto_apply in
 *     ('always','rules'):
 *       • matches and not on the file yet  → instantiate a checklist item
 *       • no longer matches                → retract, but ONLY if the engine
 *         created it and nobody has touched it (still outstanding, no docs,
 *         no notes, no sign-off/review, no tool payload). Anything a human or
 *         borrower has interacted with is never auto-removed — an underwriter
 *         can waive or un-require it manually.
 *
 * Duplicate suppression is per (application, template): any existing item for
 * the template — whatever its status — blocks re-issuance, so satisfied
 * conditions don't reappear when data wobbles in and out of range.
 *
 * Issued items are snapshots: they copy the template's wording at issuance
 * (plus template version + rule summary in origin_detail), so editing a
 * definition never rewrites conditions already on files.
 */

const db = require('../../db');
const registry = require('./field-registry');
const rules = require('./rules');
const { countBorrowerExperience } = require('../experience');

const OPEN_STATUSES = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close'];

function num(v) {
  // NULL/absent must stay null (not 0) — "is empty" tests and comparisons
  // against missing data both depend on it.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Load every registry field's current value for one application. */
async function loadRuleContext(appId) {
  const r = await db.query(
    `SELECT a.*,
            b.fico AS b_fico, b.citizenship AS b_citizenship, b.tier AS b_tier,
            b.current_address AS b_address, b.id AS b_id,
            l.is_verified AS llc_is_verified, l.formation_state AS llc_formation_state,
            pr.program AS pr_program, pr.quote AS pr_quote
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN product_registrations pr ON pr.application_id = a.id AND pr.is_current = true
      WHERE a.id = $1`, [appId]);
  const a = r.rows[0];
  if (!a) return null;

  let verified = { flips: 0, holds: 0, ground: 0, total: 0 };
  try { verified = await countBorrowerExperience(a.borrower_id, db, { verifiedOnly: true }); } catch (_) {}

  const addr = a.property_address || {};
  const bAddr = a.b_address || {};
  const quote = a.pr_quote || null;
  const loanAmount = num(a.loan_amount);
  const arv = num(a.arv);
  const cost = (num(a.purchase_price) || 0) + (num(a.rehab_budget) || 0);

  // Admin-defined custom fields: per-application answers live in
  // application_field_values and join the context like any built-in field.
  const customValues = {};
  try {
    const cv = await db.query(`SELECT field_key, value FROM application_field_values WHERE application_id=$1`, [appId]);
    for (const row of cv.rows) customValues[row.field_key] = row.value;
  } catch (_) { /* table mid-migration — no custom values */ }

  const ctx = {
    ...customValues,
    registered_program: a.pr_program || 'none',
    program_strategy: registry.normStrategy([a.program, a.loan_type, a.rehab_type].filter(Boolean).join(' ')),
    loan_purpose: registry.normLoanPurpose(a.loan_type),
    loan_amount: loanAmount,
    ltv: num(a.ltv),
    loan_to_arv: loanAmount != null && arv ? Math.round((loanAmount / arv) * 1000) / 10 : null,
    loan_to_cost: loanAmount != null && cost > 0 ? Math.round((loanAmount / cost) * 1000) / 10 : null,
    rate_pct: num(a.rate_pct),
    requested_ir_months: num(a.requested_ir_months),
    is_assignment: !!a.is_assignment,
    status: a.status,

    property_state: registry.normState(addr.state),
    property_city: addr.city || null,
    property_zip: addr.zip || addr.postalCode || null,
    property_type: registry.normPropertyType(a.property_type),
    units: num(a.units),
    occupancy: registry.normOccupancy(a.occupancy),

    purchase_price: num(a.purchase_price),
    as_is_value: num(a.as_is_value),
    arv,
    rehab_budget: num(a.rehab_budget),
    rehab_type: registry.normRehabType(a.rehab_type),
    payoff_amount: num(a.payoff_amount),
    original_purchase_price: num(a.original_purchase_price),
    acquisition_date: dateStr(a.acquisition_date),
    underlying_contract_price: num(a.underlying_contract_price),
    assignment_fee: num(a.assignment_fee),
    sqft_pre: num(a.sqft_pre),
    sqft_post: num(a.sqft_post),
    liquidity_required: quote ? num(quote.liquidityRequired || quote.liquidity) : null,

    fico: num(a.b_fico),
    citizenship: registry.normCitizenship(a.b_citizenship),
    borrower_state: registry.normState(bAddr.state),
    tier: num(a.b_tier) || 0,
    verified_flips: verified.flips,
    verified_holds: verified.holds,
    verified_ground: verified.ground,
    requested_exp_flips: num(a.requested_exp_flips) || 0,
    requested_exp_holds: num(a.requested_exp_holds) || 0,
    requested_exp_ground: num(a.requested_exp_ground) || 0,
    has_co_borrower: !!a.co_borrower_id,

    has_llc: !!a.llc_id,
    llc_verified: !!a.llc_is_verified,
    llc_state: registry.normState(a.llc_formation_state),
  };
  return { ctx, app: a };
}

/**
 * Insert a checklist item from a template row (same column carry-over as the
 * legacy insertFromTemplate, plus Condition Center columns). `extra` sets the
 * origin bookkeeping. Returns the new item id.
 */
async function instantiateTemplate(tpl, owner, extra = {}) {
  const cols = ['template_id', 'scope', 'label', 'borrower_label', 'audience', 'item_kind',
                'role_scope', 'phase', 'hint', 'borrower_hint', 'is_gate', 'is_milestone',
                'sort_order', 'tool_key', 'clickup_field_id', 'tpr_exclude', 'created_by_kind', 'created_by_id', 'is_required',
                'field_key', 'category', 'esign_doc', 'origin_kind', 'origin_detail'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.borrower_label || null, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null, tpl.borrower_hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, tpl.tpr_exclude || false,
                extra.createdByKind || 'system', extra.createdById || null, tpl.is_required !== false,
                tpl.field_key || null, tpl.category || null, tpl.esign_doc || null,
                extra.originKind || null, extra.originDetail ? JSON.stringify(extra.originDetail) : null];
  for (const [k, v] of Object.entries(owner)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(`INSERT INTO checklist_items (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
  return r.rows[0].id;
}

async function auditEngine(action, appId, detail, actor) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actor && actor.id ? 'staff' : 'system', (actor && actor.id) || null, action, appId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort */ }
}

/**
 * The core pass. opts: { actor: {id}, reason: 'details_edited' | … , notify: true }
 * Returns { added: [{id,label,audience}], removed: [{label}] } (empty on skip).
 */
async function evaluateApplication(appId, opts = {}) {
  const out = { added: [], removed: [] };
  const loaded = await loadRuleContext(appId);
  if (!loaded) return out;
  const { ctx, app } = loaded;
  // Terminal / deleted files are frozen — no new automatic conditions.
  if (app.deleted_at || !OPEN_STATUSES.includes(app.status)) return out;

  const tpls = await db.query(
    `SELECT * FROM checklist_templates
      WHERE is_active = true AND scope = 'application' AND auto_apply IN ('always','rules')
      ORDER BY sort_order, label`);
  if (!tpls.rows.length) return out;
  const fields = await registry.fieldMap(db);

  const existing = await db.query(
    `SELECT ci.id, ci.template_id, ci.status, ci.origin_kind, ci.label, ci.notes,
            ci.signed_off_at, ci.reviewed_at, (ci.tool_payload IS NOT NULL) AS has_payload,
            EXISTS(SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id) AS has_docs
       FROM checklist_items ci
      WHERE ci.application_id = $1 AND ci.template_id IS NOT NULL`, [appId]);
  const byTemplate = new Map();
  for (const row of existing.rows) if (!byTemplate.has(row.template_id)) byTemplate.set(row.template_id, row);
  // A template may have several instances (shouldn't, but be safe): retracting
  // considers each; presence of ANY instance suppresses re-issuance.
  const allByTemplate = new Map();
  for (const row of existing.rows) {
    if (!allByTemplate.has(row.template_id)) allByTemplate.set(row.template_id, []);
    allByTemplate.get(row.template_id).push(row);
  }

  for (const tpl of tpls.rows) {
    let matches = false;
    if (tpl.auto_apply === 'always') matches = true;
    else if (tpl.auto_apply === 'rules' && tpl.rule_logic) {
      try { matches = rules.evaluateRule(tpl.rule_logic, ctx, fields); } catch (_) { matches = false; }
    }

    const instances = allByTemplate.get(tpl.id) || [];
    if (matches && !instances.length) {
      const summary = tpl.auto_apply === 'rules' ? rules.summarizeRule(tpl.rule_logic, { fields }) : 'applies to every file';
      const id = await instantiateTemplate(tpl, { application_id: appId }, {
        originKind: 'auto',
        originDetail: { templateVersion: tpl.version, rule: summary, reason: opts.reason || null },
      });
      // borrowerLabel must NEVER fall back to the internal tpl.label (note-buyer
      // context) — it is interpolated into the borrower notification below.
      out.added.push({ id, label: tpl.label, borrowerLabel: tpl.borrower_label || null, audience: tpl.audience });
    } else if (!matches && tpl.auto_apply === 'rules' && instances.length) {
      for (const inst of instances) {
        const untouched = inst.origin_kind === 'auto' && inst.status === 'outstanding'
          && !inst.signed_off_at && !inst.reviewed_at && !inst.has_payload && !inst.has_docs && !inst.notes;
        if (!untouched) continue;
        await db.query(`DELETE FROM checklist_items WHERE id = $1`, [inst.id]);
        out.removed.push({ label: inst.label });
      }
    }
  }

  if (out.added.length || out.removed.length) {
    await auditEngine('conditions_auto_evaluated', appId, {
      reason: opts.reason || null,
      added: out.added.map((x) => x.label),
      removed: out.removed.map((x) => x.label),
    }, opts.actor);
  }

  // One borrower notification per pass, only for borrower-visible additions.
  const visible = out.added.filter((x) => x.audience === 'borrower' || x.audience === 'both');
  if (visible.length && opts.notify !== false) {
    try {
      const notify = require('../notify');
      const names = visible.map((x) => x.borrowerLabel ? `"${x.borrowerLabel}"` : 'a new item').join(', ');
      await notify.notifyAppBorrowers(appId, {
        type: 'condition_added',
        title: visible.length === 1 ? 'A new item was added to your file' : `${visible.length} new items were added to your file`,
        body: `${names} ${visible.length === 1 ? 'was' : 'were'} added to your conditions. Sign in to take care of ${visible.length === 1 ? 'it' : 'them'}.`,
        applicationId: appId, link: `/app/${appId}`, ctaLabel: 'Open your conditions',
      });
    } catch (_) { /* best-effort */ }
  }
  return out;
}

/** Re-run the engine on every open application (optionally only reporting one template). */
async function evaluateAllOpen(opts = {}) {
  const apps = await db.query(
    `SELECT id FROM applications
      WHERE deleted_at IS NULL AND status = ANY($1::text[])
      ORDER BY created_at DESC LIMIT 2000`, [OPEN_STATUSES]);
  const totals = { files: apps.rows.length, filesTouched: 0, added: 0, removed: 0 };
  for (const row of apps.rows) {
    try {
      const r = await evaluateApplication(row.id, { ...opts, reason: opts.reason || 'bulk_evaluation' });
      if (r.added.length || r.removed.length) totals.filesTouched++;
      totals.added += r.added.length;
      totals.removed += r.removed.length;
    } catch (_) { /* one bad file never stops the sweep */ }
  }
  return totals;
}

/** Re-run the engine on every open application belonging to a borrower (profile fields changed). */
async function evaluateBorrowerApplications(borrowerId, opts = {}) {
  const apps = await db.query(
    `SELECT id FROM applications
      WHERE (borrower_id = $1 OR co_borrower_id = $1) AND deleted_at IS NULL AND status = ANY($2::text[])`,
    [borrowerId, OPEN_STATUSES]);
  for (const row of apps.rows) {
    try { await evaluateApplication(row.id, opts); } catch (_) {}
  }
}

/**
 * Persist a borrower's answer to an info-field condition — built-in fields
 * write the real application/borrower column; admin-defined custom fields
 * upsert into application_field_values. Returns { value } (normalized) or
 * throws { status, message }.
 */
async function writeFieldValue(appId, borrowerId, fieldKey, rawValue, by = {}) {
  const fields = await registry.fieldMap(db);
  const f = fields[fieldKey];
  const target = registry.WRITE_TARGETS[fieldKey];
  if (!f || !f.writable || (!target && !f.custom)) {
    const err = new Error('this field cannot be updated from a condition'); err.status = 400; throw err;
  }
  let value = rawValue;
  if (['money', 'number', 'percent'].includes(f.type)) {
    value = Number(String(rawValue).replace(/[$,\s]/g, ''));
    if (!isFinite(value)) { const err = new Error(`${f.label} must be a number`); err.status = 400; throw err; }
    if (f.type !== 'percent' && value < 0) { const err = new Error(`${f.label} cannot be negative`); err.status = 400; throw err; }
    if (fieldKey === 'fico' && (value < 300 || value > 850)) { const err = new Error('credit score must be between 300 and 850'); err.status = 400; throw err; }
    if (fieldKey === 'requested_ir_months' && (value < 0 || value > 24)) { const err = new Error('interest reserve must be 0–24 months'); err.status = 400; throw err; }
    if (/^(requested_exp|units|sqft)/.test(fieldKey)) value = Math.round(value);
  } else if (f.type === 'date') {
    value = String(rawValue).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { const err = new Error(`${f.label} must be a YYYY-MM-DD date`); err.status = 400; throw err; }
  } else if (f.type === 'enum') {
    if (!(f.options || []).some((o) => o.v === rawValue)) { const err = new Error(`${f.label}: pick one of the listed options`); err.status = 400; throw err; }
    value = rawValue;
  } else if (f.type === 'boolean') {
    value = !!rawValue;
  } else {
    value = String(rawValue == null ? '' : rawValue).slice(0, 500);
  }

  if (f.custom) {
    await db.query(
      `INSERT INTO application_field_values (application_id, field_key, value, updated_by_kind, updated_by_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (application_id, field_key)
       DO UPDATE SET value=EXCLUDED.value, updated_by_kind=EXCLUDED.updated_by_kind,
                     updated_by_id=EXCLUDED.updated_by_id, updated_at=now()`,
      [appId, fieldKey, JSON.stringify(value), by.kind || 'borrower', by.id || null]);
  } else if (target.table === 'applications') {
    await db.query(`UPDATE applications SET ${target.column}=$2, updated_at=now() WHERE id=$1`, [appId, value]);
  } else {
    await db.query(`UPDATE borrowers SET ${target.column}=$2, updated_at=now() WHERE id=$1`, [borrowerId, value]);
  }
  return { value };
}

module.exports = {
  OPEN_STATUSES,
  loadRuleContext,
  instantiateTemplate,
  evaluateApplication,
  evaluateAllOpen,
  evaluateBorrowerApplications,
  writeFieldValue,
};
