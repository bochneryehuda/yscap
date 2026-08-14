'use strict';
/**
 * LONG-TERM (LT) — Encompass FIELD INTELLIGENCE.
 *
 * WHAT THIS IS. The other half of the Encompass memory. `completion-rules.js` says
 * which fields a milestone *requires*; this module says what those fields — and
 * ~3,700 more — actually *contain* on real loans in this tenant.
 *
 * WHERE IT COMES FROM. A read-only census of the live YS Capital Group tenant
 * (instance BE11397907) taken 2026-08-14:
 *   • 24,560 field definitions read from the tenant's own schema
 *     (GET /encompass/v3/schemas/loan/standardFields — 23,704 standard fields, and
 *      GET /encompass/v3/settings/loan/customFields — 856 custom fields).
 *   • 772 loans pulled whole (GET /encompass/v3/loans/{id}) — every loan in the
 *     pipeline, not a sample: 490 DSCR (long-term), 251 Fix & Flip (short-term),
 *     31 other.
 *   • Each field definition carries a jsonPath; resolving those paths against each
 *     loan gives the real value of every field id on every loan. 3,783 field ids
 *     carry data somewhere in the tenant.
 *
 * WHAT EACH ENTRY TELLS YOU (dictionary/field-dictionary.json):
 *   id, kind ('standard' | 'custom'), label ......... what the field IS
 *   declaredType / declaredFormat .................. the type Encompass declares
 *   observedTypes .................................. the types actually seen
 *   allowedValues .................................. the enum, with display text
 *   contractPath / jsonPath ........................ where it lives in the loan JSON
 *   fill.dscrPct / fill.fixflipPct ................. how often it is filled, per product
 *   populatedFrom / fillByStage .................... the milestone it fills up at
 *   range / dateRange / observedValues ............. the actual data
 *   calculated / calculation ....................... the tenant's own formula
 *
 * PRIVACY. The census reduced identifying and high-cardinality fields to
 * `valuesWithheld` — no borrower name, SSN, DOB, email, phone or property address
 * value is stored here. Ranges, enums and fill rates are kept for everything.
 *
 * READ-ONLY. Reference knowledge. Nothing here is enforced and nothing writes.
 */

const DICT = require('./dictionary/field-dictionary.json');

const FIELDS = DICT.fields;
const META = DICT.meta;

/** Every field id we have evidence for. */
function ids() { return Object.keys(FIELDS); }

/** One field's full intelligence, or null. */
function field(id) { return FIELDS[String(id)] || null; }

/**
 * The fields a long-term (DSCR) file actually carries, most-filled first.
 * `minPct` defaults to 1 so the tail of near-never-used fields stays out.
 */
function dscrFields({ minPct = 1, kind = null } = {}) {
  return Object.values(FIELDS)
    .filter((f) => f.fill.dscrPct >= minPct && (!kind || f.kind === kind))
    .sort((a, b) => b.fill.dscrPct - a.fill.dscrPct);
}

/** Fields present on essentially every DSCR file — the long-term backbone. */
function alwaysOnDscr(threshold = 95) {
  return dscrFields({ minPct: threshold });
}

/**
 * Where long-term and short-term diverge. A positive `gap` means the field is a
 * DSCR field; a negative `gap` means it belongs to the Fix & Flip (RTL) workflow.
 * This is the answer to "which fields are different, and which are the same".
 */
function productDifferences({ minGap = 40 } = {}) {
  return Object.values(FIELDS)
    .map((f) => ({ id: f.id, label: f.label, kind: f.kind,
      dscrPct: f.fill.dscrPct, fixflipPct: f.fill.fixflipPct,
      gap: Math.round((f.fill.dscrPct - f.fill.fixflipPct) * 10) / 10 }))
    .filter((f) => Math.abs(f.gap) >= minGap)
    .sort((a, b) => b.gap - a.gap);
}

/** Fields that both products fill the same way — the shared core. */
function sharedCore({ minPct = 80, maxGap = 10 } = {}) {
  return Object.values(FIELDS)
    .filter((f) => f.fill.dscrPct >= minPct && Math.abs(f.fill.dscrPct - f.fill.fixflipPct) <= maxGap)
    .sort((a, b) => b.fill.dscrPct - a.fill.dscrPct);
}

/** Which fields come alive at a given milestone (the stage-of-fill view). */
function populatedAt(milestone) {
  return Object.values(FIELDS)
    .filter((f) => f.populatedFrom === String(milestone))
    .sort((a, b) => b.fill.dscrPct - a.fill.dscrPct);
}

/** Free-text search over id, label and contract path. */
function search(q, { limit = 50 } = {}) {
  const s = String(q || '').toLowerCase();
  if (!s) return [];
  return Object.values(FIELDS)
    .filter((f) => f.id.toLowerCase().includes(s)
      || (f.label || '').toLowerCase().includes(s)
      || (f.contractPath || '').toLowerCase().includes(s))
    .sort((a, b) => b.fill.dscrPct - a.fill.dscrPct)
    .slice(0, limit);
}

/** Every calculated custom field with the tenant's own formula. */
function calculatedFields() {
  return Object.values(FIELDS)
    .filter((f) => f.calculated)
    .sort((a, b) => b.fill.dscrPct - a.fill.dscrPct);
}

/** A compact overview of the census. */
function summary() {
  const all = Object.values(FIELDS);
  const byKind = all.reduce((m, f) => { m[f.kind] = (m[f.kind] || 0) + 1; return m; }, {});
  const byType = all.reduce((m, f) => { const t = f.declaredType || 'unknown'; m[t] = (m[t] || 0) + 1; return m; }, {});
  return {
    ...META,
    fields: all.length,
    byKind,
    byDeclaredType: byType,
    alwaysOnDscr: all.filter((f) => f.fill.dscrPct >= 95).length,
    dscrOnly: all.filter((f) => f.fill.dscrPct >= 40 && f.fill.fixflipPct < 5).length,
    fixflipOnly: all.filter((f) => f.fill.fixflipPct >= 40 && f.fill.dscrPct < 5).length,
    calculated: all.filter((f) => f.calculated).length,
    withAllowedValues: all.filter((f) => f.allowedValues).length,
    valuesWithheldForPrivacy: all.filter((f) => f.valuesWithheld).length,
  };
}

module.exports = {
  META, FIELDS,
  ids, field, dscrFields, alwaysOnDscr, productDifferences, sharedCore,
  populatedAt, search, calculatedFields, summary,
};
