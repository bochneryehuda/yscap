'use strict';

/**
 * Admin Condition Studio API — mounted at /api/admin/conditions (admin +
 * super_admin only, enforced by the parent admin router).
 *
 * This is where an admin authors the global condition library: every
 * definition in checklist_templates (the seeded/built-in ones included, so the
 * team can see exactly how today's conditions are built, reword them, attach
 * rule logic, or retire them) plus brand-new definitions with rule-driven
 * auto-application handled by src/lib/conditions/engine.js.
 */

const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const { scrubText } = require('../lib/borrower-safe');
const registry = require('../lib/conditions/field-registry');
const rules = require('../lib/conditions/rules');
const engine = require('../lib/conditions/engine');
const { CONDITION_TYPES, TOOLS, CATEGORIES, conditionTypeOf } = require('../lib/conditions/types');

async function audit(req, action, entity_type, entity_id, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entity_type, entity_id, req.ip, req.get('user-agent') || null,
       detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* audit is best-effort */ }
}

const AUDIENCES = ['borrower', 'staff', 'both'];
const AUTO_APPLY = ['always', 'rules', 'manual'];

function slugify(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'condition';
}

/**
 * Validate + normalize a definition payload. Returns { error } or the
 * normalized column values. `existing` is the current row on updates.
 * `fields` is the merged built-in + custom field map (registry.fieldMap()).
 */
function normalizeDefinition(b, existing, fields) {
  const byKey = fields || registry.BY_KEY;
  const out = {};
  const label = b.label !== undefined ? String(b.label || '').trim() : (existing ? existing.label : '');
  if (!label) return { error: 'label is required' };
  out.label = label.slice(0, 300);

  const type = b.conditionType || (existing ? conditionTypeOf(existing) : null);
  if (!CONDITION_TYPES[type]) return { error: 'bad conditionType' };
  out.item_kind = CONDITION_TYPES[type].itemKind;
  if (type === 'tool') {
    const toolKey = b.toolKey !== undefined ? b.toolKey : (existing ? existing.tool_key : null);
    if (!TOOLS.some((t) => t.v === toolKey)) return { error: 'pick a form/tool for a tool condition' };
    out.tool_key = toolKey;
  } else {
    out.tool_key = CONDITION_TYPES[type].toolKey;
  }

  const audience = b.audience !== undefined ? b.audience : (existing ? existing.audience : 'borrower');
  if (!AUDIENCES.includes(audience)) return { error: 'bad audience' };
  out.audience = audience;

  if (type === 'info_field') {
    const fieldKey = b.fieldKey !== undefined ? b.fieldKey : (existing ? existing.field_key : null);
    const f = byKey[fieldKey];
    if (!f || !f.writable) return { error: 'an information condition needs a fillable field' };
    if (audience === 'staff') return { error: 'an information condition must be visible to the borrower (external or both)' };
    out.field_key = fieldKey;
  } else {
    out.field_key = null;
  }

  if ((type === 'internal_task' || type === 'internal_condition') && audience !== 'staff') {
    return { error: 'internal tasks/checkpoints must have an internal audience' };
  }
  if (type === 'document' || type === 'esign' || type === 'tool') {
    // borrower-actionable kinds may be staff-only (staff uploads on their behalf) — no restriction.
  }

  const category = b.category !== undefined ? (b.category || null) : (existing ? existing.category : null);
  if (category && !CATEGORIES.some((c) => c.v === category)) return { error: 'bad category' };
  out.category = category;

  const autoApply = b.autoApply !== undefined ? (b.autoApply || null) : (existing ? existing.auto_apply : 'manual');
  if (autoApply !== null && !AUTO_APPLY.includes(autoApply)) return { error: 'bad autoApply' };
  out.auto_apply = autoApply;

  let ruleLogic = b.ruleLogic !== undefined ? b.ruleLogic : (existing ? existing.rule_logic : null);
  if (ruleLogic != null && typeof ruleLogic === 'string') { try { ruleLogic = JSON.parse(ruleLogic); } catch (_) { return { error: 'ruleLogic is not valid JSON' }; } }
  if (out.auto_apply === 'rules') {
    if (!ruleLogic) return { error: 'add at least one rule, or set the condition to apply to every file' };
    const problems = rules.validateRule(ruleLogic, { fields: byKey });
    if (problems.length) return { error: 'rule problems: ' + problems.join('; ') };
  } else if (ruleLogic) {
    const problems = rules.validateRule(ruleLogic, { fields: byKey });
    if (problems.length) return { error: 'rule problems: ' + problems.join('; ') };
  }
  out.rule_logic = ruleLogic ? JSON.stringify(ruleLogic) : null;
  if (out.auto_apply && existing && existing.scope && existing.scope !== 'application') {
    return { error: 'automatic rules only run on application-scoped conditions' };
  }

  out.borrower_label = b.borrowerLabel !== undefined ? (String(b.borrowerLabel || '').trim().slice(0, 300) || null) : (existing ? existing.borrower_label : null);
  // A borrower-visible condition MUST carry borrower wording, or the portal shows
  // the generic "An item your loan team needs" placeholder (#78). For plain
  // label-rendered kinds (document / generic condition) that were authored for
  // the borrower without a separate borrower label, use the main label — the
  // author already chose to show this to the borrower, so the label they typed
  // is the borrower wording. (Tool / e-sign / info-field render their own copy.)
  if (!out.borrower_label && (audience === 'borrower' || audience === 'both')
      && !out.tool_key && !out.esign_doc && out.field_key == null) {
    out.borrower_label = out.label;
  }
  out.hint = b.hint !== undefined ? (String(b.hint || '').trim().slice(0, 2000) || null) : (existing ? existing.hint : null);
  out.borrower_hint = b.borrowerHint !== undefined ? (String(b.borrowerHint || '').trim().slice(0, 2000) || null) : (existing ? existing.borrower_hint : null);
  // Borrower-facing wording must never carry a capital-partner name — replace any
  // with the program name. Also covers the blank-borrower-label default above,
  // which copies the INTERNAL label into borrower_label.
  out.borrower_label = scrubText(out.borrower_label);
  out.borrower_hint = scrubText(out.borrower_hint);
  out.esign_doc = b.esignDoc !== undefined ? (String(b.esignDoc || '').trim().slice(0, 300) || null) : (existing ? existing.esign_doc : null);
  out.phase = b.phase !== undefined ? (b.phase || null) : (existing ? existing.phase : null);
  out.sort_order = b.sortOrder !== undefined ? (Number(b.sortOrder) || 500) : (existing ? existing.sort_order : 500);
  out.is_required = b.isRequired !== undefined ? b.isRequired !== false : (existing ? existing.is_required !== false : true);
  return out;
}

/** Serialize a template row for the studio. */
function defOut(t, fields) {
  return {
    id: t.id, code: t.code, label: t.label, borrowerLabel: t.borrower_label,
    hint: t.hint, borrowerHint: t.borrower_hint,
    scope: t.scope, audience: t.audience, itemKind: t.item_kind, toolKey: t.tool_key,
    conditionType: conditionTypeOf(t),
    fieldKey: t.field_key, esignDoc: t.esign_doc, category: t.category, phase: t.phase,
    isGate: t.is_gate, isMilestone: t.is_milestone, isRequired: t.is_required !== false,
    isActive: t.is_active, sortOrder: t.sort_order,
    appliesProgram: t.applies_program, appliesLoanType: t.applies_loan_type,
    autoApply: t.auto_apply, ruleLogic: t.rule_logic,
    ruleSummary: t.rule_logic ? rules.summarizeRule(t.rule_logic, { fields }) : null,
    origin: t.origin, version: t.version,
    createdAt: t.created_at, updatedAt: t.updated_at,
    createdByName: t.created_by_name || null, updatedByName: t.updated_by_name || null,
    instanceCount: Number(t.instance_count || 0), openCount: Number(t.open_count || 0),
  };
}

// ---- meta: fields (built-in + custom), operators, categories, types ----
router.get('/fields', async (req, res) => {
  res.json({
    fields: await registry.publicFieldsAll(db),
    operators: rules.OPERATORS_BY_TYPE,
    operatorLabels: rules.OPERATOR_LABEL,
    categories: CATEGORIES,
    types: Object.entries(CONDITION_TYPES).map(([v, t]) => ({ v, label: t.label })),
    tools: TOOLS,
  });
});

// ---- custom fields: create a brand-new fillable field while authoring ----
const FIELD_TYPES = ['money', 'number', 'percent', 'text', 'enum', 'boolean', 'date'];

router.get('/custom-fields', async (req, res) => {
  const r = await db.query(
    `SELECT cf.*,
            (SELECT count(*) FROM checklist_templates t WHERE t.field_key=cf.key) AS template_count,
            (SELECT count(*) FROM application_field_values v WHERE v.field_key=cf.key) AS value_count
       FROM custom_fields cf ORDER BY cf.created_at`);
  res.json(r.rows.map((row) => ({
    id: row.id, key: row.key, label: row.label, type: row.type, options: row.options,
    borrowerLabel: row.borrower_label, borrowerHint: row.borrower_hint, isActive: row.is_active,
    templateCount: Number(row.template_count || 0), valueCount: Number(row.value_count || 0),
  })));
});

router.post('/custom-fields', async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'give the field a name' });
  if (!FIELD_TYPES.includes(b.type)) return res.status(400).json({ error: 'bad field type' });
  let options = null;
  if (b.type === 'enum') {
    const raw = Array.isArray(b.options) ? b.options : [];
    options = raw
      .map((o) => (typeof o === 'string' ? { v: null, label: o } : o))
      .map((o) => {
        const lab = String((o && o.label) || '').trim();
        const v = String((o && o.v) || lab).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        return lab && v ? { v, label: lab } : null;
      }).filter(Boolean);
    const seen = new Set();
    options = options.filter((o) => (seen.has(o.v) ? false : (seen.add(o.v), true)));
    if (options.length < 2) return res.status(400).json({ error: 'a dropdown field needs at least two options' });
  }
  let key = 'cf_' + slugify(label);
  const taken = await db.query(`SELECT 1 FROM custom_fields WHERE key=$1`, [key]);
  if (taken.rows[0]) key = `${key}_${Date.now().toString(36).slice(-4)}`;
  try {
    const r = await db.query(
      `INSERT INTO custom_fields (key,label,borrower_label,borrower_hint,type,options,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [key, label.slice(0, 200),
       String(b.borrowerLabel || '').trim().slice(0, 200) || null,
       String(b.borrowerHint || '').trim().slice(0, 1000) || null,
       b.type, options ? JSON.stringify(options) : null, req.actor.id]);
    registry.bustCustomFields();
    await audit(req, 'custom_field_created', 'custom_field', r.rows[0].id, { key, label, type: b.type });
    res.status(201).json({ ok: true, field: { id: r.rows[0].id, ...registry.customFieldDef(r.rows[0]) } });
  } catch (e) {
    console.error('[conditions] custom field create failed:', db.describeError ? db.describeError(e) : e.message);
    res.status(500).json({ error: 'could not create the field' });
  }
});

router.patch('/custom-fields/:id', async (req, res) => {
  const b = req.body || {};
  const cur = await db.query(`SELECT * FROM custom_fields WHERE id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'field not found' });
  const sets = [], vals = []; let i = 1;
  if (b.label !== undefined) { const l = String(b.label || '').trim(); if (!l) return res.status(400).json({ error: 'label required' }); sets.push(`label=$${i++}`); vals.push(l.slice(0, 200)); }
  if (b.borrowerLabel !== undefined) { sets.push(`borrower_label=$${i++}`); vals.push(String(b.borrowerLabel || '').trim().slice(0, 200) || null); }
  if (b.borrowerHint !== undefined) { sets.push(`borrower_hint=$${i++}`); vals.push(String(b.borrowerHint || '').trim().slice(0, 1000) || null); }
  if (b.isActive !== undefined) { sets.push(`is_active=$${i++}`); vals.push(!!b.isActive); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.query(`UPDATE custom_fields SET ${sets.join(',')} WHERE id=$${i}`, vals);
  registry.bustCustomFields();
  await audit(req, 'custom_field_updated', 'custom_field', req.params.id, { fields: Object.keys(b) });
  res.json({ ok: true });
});

router.delete('/custom-fields/:id', async (req, res) => {
  const cur = await db.query(
    `SELECT cf.*,
            (SELECT count(*) FROM checklist_templates t WHERE t.field_key=cf.key) AS template_count,
            (SELECT count(*) FROM application_field_values v WHERE v.field_key=cf.key) AS value_count,
            -- A field can be referenced ONLY inside a rule tree (no field_key,
            -- no stored value yet). Count those too, or a hard delete would leave
            -- a dangling reference that silently makes the rule never match.
            (SELECT count(*) FROM checklist_templates t
              WHERE t.rule_logic IS NOT NULL AND t.rule_logic::text LIKE '%"' || cf.key || '"%') AS rule_ref_count
       FROM custom_fields cf WHERE cf.id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'field not found' });
  const f = cur.rows[0];
  if (Number(f.template_count) > 0 || Number(f.value_count) > 0 || Number(f.rule_ref_count) > 0) {
    await db.query(`UPDATE custom_fields SET is_active=false, updated_at=now() WHERE id=$1`, [req.params.id]);
    registry.bustCustomFields();
    await audit(req, 'custom_field_deactivated', 'custom_field', req.params.id, { key: f.key });
    return res.json({ ok: true, deactivated: true });
  }
  await db.query(`DELETE FROM custom_fields WHERE id=$1`, [req.params.id]);
  registry.bustCustomFields();
  await audit(req, 'custom_field_deleted', 'custom_field', req.params.id, { key: f.key });
  res.json({ ok: true, deleted: true });
});

// ---- list the whole library (built-in + admin-authored) ----
router.get('/definitions', async (req, res) => {
  const r = await db.query(
    `SELECT t.*, cb.full_name AS created_by_name, ub.full_name AS updated_by_name,
            (SELECT count(*) FROM checklist_items ci WHERE ci.template_id = t.id) AS instance_count,
            (SELECT count(*) FROM checklist_items ci WHERE ci.template_id = t.id
               AND ci.status NOT IN ('satisfied')) AS open_count
       FROM checklist_templates t
       LEFT JOIN staff_users cb ON cb.id = t.created_by
       LEFT JOIN staff_users ub ON ub.id = t.updated_by
      ORDER BY t.is_active DESC, t.scope, t.phase NULLS LAST, t.sort_order, t.label`);
  const fields = await registry.fieldMap(db);
  res.json(r.rows.map((t) => defOut(t, fields)));
});

// ---- create a new definition ----
router.post('/definitions', async (req, res) => {
  const b = req.body || {};
  const fields = await registry.fieldMap(db);
  const norm = normalizeDefinition(b, null, fields);
  if (norm.error) return res.status(400).json({ error: norm.error });
  // unique, readable code: cc_<slug>, suffixed if taken
  let code = 'cc_' + slugify(norm.label);
  const taken = await db.query(`SELECT 1 FROM checklist_templates WHERE code=$1`, [code]);
  if (taken.rows[0]) code = `${code}_${Date.now().toString(36).slice(-4)}`;
  try {
    const r = await db.query(
      `INSERT INTO checklist_templates
         (code,label,borrower_label,hint,borrower_hint,scope,audience,item_kind,tool_key,field_key,esign_doc,
          category,phase,sort_order,is_required,is_active,auto_apply,rule_logic,origin,version,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,'application',$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,'admin',1,$17,$17)
       RETURNING *`,
      [code, norm.label, norm.borrower_label, norm.hint, norm.borrower_hint, norm.audience,
       norm.item_kind, norm.tool_key || null, norm.field_key, norm.esign_doc,
       norm.category, norm.phase, norm.sort_order, norm.is_required,
       norm.auto_apply, norm.rule_logic, req.actor.id]);
    const def = r.rows[0];
    await audit(req, 'condition_def_created', 'checklist_template', def.id,
      { label: norm.label, autoApply: norm.auto_apply, audience: norm.audience });
    // New automatic definitions sweep the open pipeline right away (unless the
    // studio asked to hold off with runNow:false).
    let run = null;
    if (['always', 'rules'].includes(norm.auto_apply) && b.runNow !== false) {
      run = await engine.evaluateAllOpen({ actor: req.actor, reason: 'definition_created' });
    }
    res.status(201).json({ ok: true, definition: defOut(def, fields), run });
  } catch (e) {
    console.error('[conditions] create failed:', db.describeError ? db.describeError(e) : e.message);
    res.status(500).json({ error: 'could not save the condition' });
  }
});

// ---- update a definition (wording, logic, activation) ----
router.patch('/definitions/:id', async (req, res) => {
  const b = req.body || {};
  const cur = await db.query(`SELECT * FROM checklist_templates WHERE id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'condition not found' });
  const existing = cur.rows[0];

  // Pure activation toggles skip full validation (built-ins may predate rules).
  if (Object.keys(b).length === 1 && 'isActive' in b) {
    await db.query(`UPDATE checklist_templates SET is_active=$2, updated_by=$3, updated_at=now() WHERE id=$1`,
      [req.params.id, !!b.isActive, req.actor.id]);
    await audit(req, b.isActive ? 'condition_def_activated' : 'condition_def_deactivated', 'checklist_template', req.params.id, { label: existing.label });
    return res.json({ ok: true });
  }

  const fields = await registry.fieldMap(db);
  const norm = normalizeDefinition(b, existing, fields);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const contentChanged = ['label', 'borrower_label', 'hint', 'borrower_hint', 'audience', 'item_kind', 'tool_key',
    'field_key', 'esign_doc', 'category', 'auto_apply', 'rule_logic', 'is_required']
    .some((k) => {
      const a = k === 'rule_logic' ? JSON.stringify(existing[k] || null) : (existing[k] == null ? null : existing[k]);
      const bv = k === 'rule_logic' ? (norm[k] || JSON.stringify(null)) : (norm[k] == null ? null : norm[k]);
      return String(a) !== String(bv === 'null' ? null : bv);
    });
  try {
    const r = await db.query(
      `UPDATE checklist_templates SET
         label=$2, borrower_label=$3, hint=$4, borrower_hint=$5, audience=$6, item_kind=$7, tool_key=$8,
         field_key=$9, esign_doc=$10, category=$11, phase=$12, sort_order=$13, is_required=$14,
         auto_apply=$15, rule_logic=$16,
         is_active=COALESCE($17, is_active),
         version=version + $18, updated_by=$19, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, norm.label, norm.borrower_label, norm.hint, norm.borrower_hint, norm.audience,
       norm.item_kind, norm.tool_key || null, norm.field_key, norm.esign_doc, norm.category, norm.phase,
       norm.sort_order, norm.is_required, norm.auto_apply, norm.rule_logic,
       'isActive' in b ? !!b.isActive : null, contentChanged ? 1 : 0, req.actor.id]);
    await audit(req, 'condition_def_updated', 'checklist_template', req.params.id,
      { label: norm.label, autoApply: norm.auto_apply, versionBumped: contentChanged });
    let run = null;
    if (['always', 'rules'].includes(norm.auto_apply) && b.runNow !== false && r.rows[0].is_active) {
      run = await engine.evaluateAllOpen({ actor: req.actor, reason: 'definition_updated' });
    }
    res.json({ ok: true, definition: defOut(r.rows[0], fields), run });
  } catch (e) {
    console.error('[conditions] update failed:', db.describeError ? db.describeError(e) : e.message);
    res.status(500).json({ error: 'could not update the condition' });
  }
});

// ---- delete (hard if never used, retire otherwise) ----
router.delete('/definitions/:id', async (req, res) => {
  // removeFromFiles: also strip this condition off the files it was placed on
  // (so "I deleted it in the admin center but it stayed on the file" is fixed).
  // Default keeps existing instances and just retires the definition.
  const removeFromFiles = (req.query.removeFromFiles === '1' || req.query.removeFromFiles === 'true'
    || (req.body && req.body.removeFromFiles === true));
  const cur = await db.query(
    `SELECT t.*, (SELECT count(*) FROM checklist_items ci WHERE ci.template_id=t.id) AS n
       FROM checklist_templates t WHERE t.id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'condition not found' });
  const t = cur.rows[0];
  const n = Number(t.n);

  if (removeFromFiles && n > 0) {
    // Remove every instance of this definition from files, then hard-delete the
    // definition. Documents linked to those items cascade (documents.checklist_item_id
    // is ON DELETE SET NULL, so the bytes stay in the file's history).
    const del = await db.query(`DELETE FROM checklist_items WHERE template_id=$1 RETURNING id`, [req.params.id]);
    await db.query(`DELETE FROM checklist_templates WHERE id=$1`, [req.params.id]);
    await audit(req, 'condition_def_deleted', 'checklist_template', req.params.id,
      { label: t.label, removedFromFiles: del.rowCount });
    return res.json({ ok: true, deleted: true, removedFromFiles: del.rowCount });
  }

  if (n > 0) {
    await db.query(`UPDATE checklist_templates SET is_active=false, updated_by=$2, updated_at=now() WHERE id=$1`,
      [req.params.id, req.actor.id]);
    await audit(req, 'condition_def_deactivated', 'checklist_template', req.params.id, { label: t.label, reason: 'delete_with_instances' });
    return res.json({ ok: true, deactivated: true, instanceCount: n });
  }
  await db.query(`DELETE FROM checklist_templates WHERE id=$1`, [req.params.id]);
  await audit(req, 'condition_def_deleted', 'checklist_template', req.params.id, { label: t.label });
  res.json({ ok: true, deleted: true });
});

// ---- preview: how many open files would a rule match right now? ----
router.post('/preview-rule', async (req, res) => {
  let tree = (req.body || {}).ruleLogic;
  if (typeof tree === 'string') { try { tree = JSON.parse(tree); } catch (_) { return res.status(400).json({ error: 'bad rule JSON' }); } }
  if (!tree) return res.status(400).json({ error: 'ruleLogic required' });
  const fields = await registry.fieldMap(db);
  const problems = rules.validateRule(tree, { fields });
  if (problems.length) return res.status(400).json({ error: problems.join('; '), problems });
  const apps = await db.query(
    `SELECT a.id, a.ys_loan_number, a.property_address, b.first_name, b.last_name
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.deleted_at IS NULL AND a.status = ANY($1::text[])
      ORDER BY a.created_at DESC LIMIT 500`, [engine.OPEN_STATUSES]);
  let matches = 0; const sample = [];
  // `fields` (the merged built-in + custom map, from validation above) is passed
  // into evaluateRule so rules on custom (cf_*) fields evaluate the same way the
  // live engine does — otherwise Preview would show 0 matches for such a rule.
  for (const row of apps.rows) {
    try {
      const loaded = await engine.loadRuleContext(row.id);
      if (loaded && rules.evaluateRule(tree, loaded.ctx, fields)) {
        matches++;
        if (sample.length < 6) {
          const addr = row.property_address || {};
          sample.push({
            id: row.id, ysLoanNumber: row.ys_loan_number,
            borrower: [row.first_name, row.last_name].filter(Boolean).join(' '),
            address: addr.oneLine || [addr.line1 || addr.street, addr.city, addr.state].filter(Boolean).join(', '),
          });
        }
      }
    } catch (_) { /* skip broken files */ }
  }
  res.json({ total: apps.rows.length, matches, sample, summary: rules.summarizeRule(tree, { fields }) });
});

// ---- run the engine across the whole open pipeline ----
router.post('/run-all', async (req, res) => {
  const totals = await engine.evaluateAllOpen({ actor: req.actor, reason: 'manual_run_all' });
  await audit(req, 'conditions_run_all', 'checklist_template', null, totals);
  res.json({ ok: true, ...totals });
});

module.exports = router;
