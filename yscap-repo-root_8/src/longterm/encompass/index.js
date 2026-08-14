'use strict';
/**
 * LONG-TERM (LT) — Encompass knowledge module: the single accessor for the whole
 * Encompass "memory". It ties together:
 *   • client            — the read-only Encompass API client (auth + requests)
 *   • completion-rules  — the Milestone Completion rules + field requirements
 *   • reconciliation-map— the RTL field map (all mapped fields, RTL usage labeled)
 *   • requests          — the request/authorization catalog
 * and builds ONE UNIFIED FIELD CATALOG so a developer or an AI can ask "what
 * Encompass fields do we know, and when/why is each needed?" in one place.
 *
 * Nothing here enforces anything. It is reference knowledge only.
 */

const client = require('./client');
const rules = require('./completion-rules');
const reconciliation = require('./reconciliation-map');
const requests = require('./requests');
// The 2026-08-14 live census of the tenant — what the fields actually CONTAIN, how a
// loan file is SHAPED, the tenant's own formulas, the condition/eFolder model, and
// which API calls really answer. See each module's header for provenance.
const intelligence = require('./field-intelligence');
const anatomy = require('./loan-anatomy');
const formulas = require('./formulas');
const terms = require('./terms');
const conditions = require('./conditions');
const apiSurface = require('./api-surface');
const investors = require('./investors');
const dropdowns = require('./dropdowns');
const mismo = require('./mismo');
const programs = require('./dictionary/program-taxonomy.json');
const conditionLibrary = require('./dictionary/condition-library.json');
const efolderCatalog = require('./dictionary/efolder-catalog.json');

// Classify a field id into a family for grouping/reading.
function familyOf(id) {
  const s = String(id || '');
  if (/^CX\./i.test(s)) return 'custom';
  if (/^CUST/i.test(s)) return 'custom';
  if (/^URLA\./i.test(s)) return 'urla';
  if (/^#?FR\d/i.test(s)) return 'form';
  if (/^VEND\./i.test(s)) return 'vendor';
  if (/^\d+$/.test(s)) return 'standard';
  return 'other';
}

// Build the unified field catalog by merging every source, keyed on field id.
// A field can be required by several rules and also be an RTL-reconciled field;
// we keep ALL of that on one entry so nothing is lost.
function buildFieldCatalog() {
  const byId = new Map();
  const ensure = (fieldId) => {
    const key = String(fieldId);
    if (!byId.has(key)) {
      byId.set(key, {
        fieldId: key,
        family: familyOf(key),
        descriptions: new Set(),
        requiredByRules: [],   // { rule, milestone, source }
        rtlReconciliation: null, // the RTL registry entry, if this field is reconciled
        staffOnly: false,
        notes: [],
      });
    }
    return byId.get(key);
  };

  // 1) Milestone Completion requirements — base rule + per-rule fields.
  const addReq = (ruleName) => (f) => {
    const e = ensure(f.fieldId);
    if (f.description) e.descriptions.add(f.description);
    e.requiredByRules.push({ rule: ruleName, milestone: f.milestone, source: f.source });
    if (f.staffOnly) e.staffOnly = true;
  };
  rules.BASE_RULE_FIELDS.forEach(addReq('milestone completion field requirements'));
  for (const [ruleName, list] of Object.entries(rules.RULE_FIELDS)) list.forEach(addReq(ruleName));

  // 2) RTL reconciliation registry (all mapped fields) — labeled RTL usage.
  for (const entry of reconciliation.REGISTRY) {
    if (!entry.encompassFieldId) continue;
    const e = ensure(entry.encompassFieldId);
    if (entry.note) e.descriptions.add(entry.note);
    e.rtlReconciliation = {
      key: entry.key, our: entry.our, gate: entry.gate, category: entry.category,
      direction: entry.direction, loanPath: entry.loanPath, type: entry.type,
    };
  }
  // 3) RTL identity fields (name/DOB/SSN/phone/email/vesting) — also mapped fields.
  for (const [key, ids] of Object.entries(reconciliation.IDENTITY_MAP)) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      if (!id) continue;
      const e = ensure(id);
      e.rtlReconciliation = e.rtlReconciliation || { key, our: 'identity', gate: 'identity', category: 'identity' };
      if (/ssn|social/i.test(key) || String(id) === '65' || String(id) === '97') e.notes.push('PII (SSN)');
    }
  }

  // Freeze to plain objects (Sets → arrays) for JSON serving.
  return [...byId.values()]
    .map((e) => ({
      fieldId: e.fieldId,
      family: e.family,
      description: [...e.descriptions][0] || null,
      allDescriptions: [...e.descriptions],
      requiredByRules: e.requiredByRules,
      milestones: [...new Set(e.requiredByRules.map((r) => r.milestone).filter(Boolean))],
      rtlReconciliation: e.rtlReconciliation,
      isRtlReconciled: !!e.rtlReconciliation,
      staffOnly: e.staffOnly,
      notes: [...new Set(e.notes)],
    }))
    .sort((a, b) => a.fieldId.localeCompare(b.fieldId, undefined, { numeric: true }));
}

let _catalog = null;
function fieldCatalog() { if (!_catalog) _catalog = buildFieldCatalog(); return _catalog; }
function fieldById(id) { return fieldCatalog().find((f) => f.fieldId === String(id)) || null; }

// A compact summary of the whole Encompass memory.
function summary() {
  const cat = fieldCatalog();
  return {
    fields: cat.length,
    fieldsByFamily: cat.reduce((m, f) => { m[f.family] = (m[f.family] || 0) + 1; return m; }, {}),
    rulesCaptured: rules.RULES.length,
    rulesTotal: rules.MISSING.rulesTotal,
    rulesMissing: rules.MISSING.rulesMissing,
    reconciliationFields: reconciliation.REGISTRY.length,
    requestEndpoints: requests.REQUESTS.length,
    readOnly: client.READ_ONLY,
    // The live census layered on top of the rule-derived catalog above.
    intelligence: intelligence.summary(),
    programs: programs.programs.length,
    conditionTemplates: conditionLibrary.templates.length,
    efolderDocumentTypes: efolderCatalog.documentTypes.length,
    apiSurface: apiSurface.summary(),
    investors: investors.summary(),
    dropdowns: dropdowns.summary(),
    terms: terms.summary(),
  };
}

module.exports = {
  client,
  rules,
  reconciliation,
  requests,
  fieldCatalog,
  fieldById,
  familyOf,
  summary,
  // The live-census layer.
  intelligence,
  anatomy,
  formulas,
  terms,
  conditions,
  apiSurface,
  investors,
  dropdowns,
  mismo,
  programs,
  conditionLibrary,
  efolderCatalog,
};
