'use strict';
/**
 * P4 — Independent-verification RECONCILER (deterministic core, ADVISORY).
 *
 * The owner's Gap 4: move from "the submitted documents AGREE with each other"
 * to "the documents agree AND an INDEPENDENT source supports them." The direct-
 * source hub (direct-source-hub.js) records what an outside source says (Plaid
 * account ownership + balance, Middesk/SoS entity status, ATTOM/HouseCanary
 * property value, Xactus credit) into the twin. But nothing yet COMPARES that
 * independent answer to what the DOCUMENTS claimed and raises a conflict. This
 * module is that comparison: given a document-claimed value and an independent
 * source's value, it decides CONFIRMED / CONFLICT / UNVERIFIABLE per verification
 * type and, on a conflict, emits an advisory finding for a human.
 *
 * Pure: no DB, no HTTP, no AI. The connectors fetch; the hub records; this
 * reconciles. Advisory — a conflict is a SUGGESTION a human reviews; it never
 * blocks, clears, or changes a decision on its own.
 */

const STATUS = Object.freeze({ CONFIRMED: 'confirmed', CONFLICT: 'conflict', UNVERIFIABLE: 'unverifiable' });

// -- normalizers --
function normName(v) {
  return String(v == null ? '' : v).toLowerCase()
    // entity-suffix-tolerant: L.L.C. == LLC == "Limited Liability Company"
    .replace(/limited liability company/g, 'llc')
    .replace(/\b(l\.?l\.?c\.?|inc\.?|corp\.?|co\.?|ltd\.?|l\.?p\.?)\b/g, (m) => m.replace(/\./g, ''))
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function num(v) { const s = String(v == null ? '' : v).replace(/[$,\s]/g, ''); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; }
function normStatus(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z]+/g, ''); }

// Entity statuses that mean "in good standing / can transact".
const GOOD_ENTITY = new Set(['active', 'goodstanding', 'ingoodstanding', 'existing', 'current', 'inexistence']);

// -- per-type comparison --
// Each returns { match, detail }.
const COMPARATORS = {
  // Names / ownership — entity-suffix tolerant equality. If either side
  // normalizes to empty (blank, or only punctuation/suffix noise), there is no
  // name to compare → UNVERIFIABLE, never a (fatal) ownership mismatch.
  name(docV, srcV) {
    const a = normName(docV), b = normName(srcV);
    if (!a || !b) return { match: false, detail: `document "${docV}" vs source "${srcV}"`, unverifiable: true };
    return { match: a === b, detail: `document "${docV}" vs source "${srcV}"` };
  },
  // Amounts / balances — within a tolerance (absolute OR percent, whichever the
  // opts give; default 1% or $1 — a balance "as of" a slightly different day
  // shouldn't false-conflict, but a materially different number should).
  amount(docV, srcV, opts) {
    const a = num(docV), b = num(srcV);
    if (a == null || b == null) return { match: false, detail: 'a value was not numeric', unverifiable: true };
    const absTol = opts && opts.absTolerance != null ? opts.absTolerance : 1;
    const pctTol = opts && opts.pctTolerance != null ? opts.pctTolerance : 0.01;
    const diff = Math.abs(a - b);
    const within = diff <= absTol || diff <= Math.abs(a) * pctTol;
    return { match: within, detail: `document $${a} vs source $${b} (Δ $${+diff.toFixed(2)})` };
  },
  // Entity status — the source's registry status must be a "good standing" value.
  // A blank/absent status is UNVERIFIABLE (the registry gave no answer), never a
  // conflict — only a status that is present AND not good-standing conflicts.
  entity_status(docV, srcV) {
    const s = normStatus(srcV);
    if (!s) return { match: false, detail: 'registry status not provided', unverifiable: true };
    return { match: GOOD_ENTITY.has(s), detail: `registry status "${srcV}"` };
  },
  // Property value — the independent AVM within a variance band of the claimed
  // (appraisal) value. Default ±10% (a normal AVM confidence band); outside that
  // is a value-support conflict a human should see.
  property_value(docV, srcV, opts) {
    const a = num(docV), b = num(srcV);
    if (a == null || b == null) return { match: false, detail: 'a value was not numeric', unverifiable: true };
    // Without a positive claimed value there is no base to compute a variance
    // against → UNVERIFIABLE (never a self-conflict on a degenerate $0 claim).
    if (a <= 0) return { match: false, detail: `claimed value is not positive ($${a})`, unverifiable: true };
    const band = opts && opts.varianceBand != null ? opts.varianceBand : 0.10;
    const variance = Math.abs(a - b) / a;
    return { match: variance <= band, detail: `claimed $${a} vs AVM $${b} (${(variance * 100).toFixed(1)}% variance, band ±${(band * 100).toFixed(0)}%)` };
  },
  // Existence / boolean — the source confirms a thing exists / is true.
  exists(docV, srcV) {
    return { match: srcV === true || String(srcV).toLowerCase() === 'true' || srcV === 'found', detail: `source: ${srcV}` };
  },
};

// A material finding code + severity per verification type, raised ONLY on conflict.
const CONFLICT_META = {
  name:           { code: 'verify_ownership_mismatch', severity: 'fatal',   title: 'Independent source does not confirm the account/entity owner' },
  amount:         { code: 'verify_amount_mismatch',    severity: 'warning', title: 'Independent source shows a different amount than the document' },
  entity_status:  { code: 'verify_entity_not_active',  severity: 'fatal',   title: 'Independent registry does not show the entity in good standing' },
  property_value: { code: 'verify_value_unsupported',  severity: 'warning', title: 'Independent AVM does not support the claimed property value' },
  exists:         { code: 'verify_not_found',          severity: 'warning', title: 'Independent source could not confirm the claimed item' },
};

/**
 * reconcile(claim, source, opts?) → {
 *   status: 'confirmed'|'conflict'|'unverifiable',
 *   type, provider, detail, finding?  // finding present ONLY on conflict
 * }
 *   claim:  { type, value, field? }         — what the DOCUMENTS say
 *   source: { value, available?, provider } — what the INDEPENDENT source says
 * A source that is not available/configured, or has no value, is UNVERIFIABLE
 * (never a conflict — absence of an independent answer is not a disagreement).
 */
function reconcile(claim, source, opts = {}) {
  const type = claim && claim.type;
  const provider = (source && source.provider) || null;
  const cmp = COMPARATORS[type];
  const base = { type, provider, field: (claim && claim.field) || null };

  if (!cmp) return { ...base, status: STATUS.UNVERIFIABLE, detail: `no comparator for verification type "${type}"` };
  // A claim with no document-stated value is UNVERIFIABLE — a field the document
  // never asserted is not a disagreement (mirrors the source-side guard below).
  if (!claim || claim.value == null || (typeof claim.value === 'string' && claim.value.trim() === '')) {
    return { ...base, status: STATUS.UNVERIFIABLE, detail: 'no document-claimed value to reconcile' };
  }
  if (!source || source.available === false || source.value == null
      || (typeof source.value === 'string' && source.value.trim() === '')) {
    return { ...base, status: STATUS.UNVERIFIABLE, detail: 'no independent source value available' };
  }

  const r = cmp(claim.value, source.value, opts);
  if (r.unverifiable) return { ...base, status: STATUS.UNVERIFIABLE, detail: r.detail };
  if (r.match) return { ...base, status: STATUS.CONFIRMED, detail: r.detail };

  const meta = CONFLICT_META[type] || { code: 'verify_conflict', severity: 'warning', title: 'Independent source conflicts with the document' };
  return {
    ...base,
    status: STATUS.CONFLICT,
    detail: r.detail,
    finding: {
      code: meta.code,
      severity: meta.severity,
      status: 'open',
      source: 'independent_verification',
      title: meta.title,
      field: base.field,
      docValue: claim.value,
      sourceValue: source.value,
      provider,
      howTo: `${meta.title}. The document says "${claim.value}"; ${provider || 'the independent source'} says "${source.value}". Review by hand — nothing is changed automatically.`,
      actions: ['open_condition', 'request_revision', 'dismiss'],
    },
  };
}

/**
 * reconcileAll(claims) → { results:[reconcile...], findings:[...], summary }.
 * claims: [{ claim, source, opts? }]. Rolls up the per-claim results, collects
 * the conflict findings, and summarizes coverage (how much of the file an
 * independent source actually confirmed vs left unverifiable).
 */
function reconcileAll(claims) {
  const list = Array.isArray(claims) ? claims : [];
  const results = list.map((c) => reconcile(c && c.claim, c && c.source, (c && c.opts) || {}));
  const findings = results.filter((r) => r.status === STATUS.CONFLICT && r.finding).map((r) => r.finding);
  const count = (s) => results.filter((r) => r.status === s).length;
  const confirmed = count(STATUS.CONFIRMED), conflict = count(STATUS.CONFLICT), unverifiable = count(STATUS.UNVERIFIABLE);
  return {
    results,
    findings,
    summary: {
      total: results.length, confirmed, conflict, unverifiable,
      // Independent-coverage = share of claims an outside source actually spoke to.
      coverage: results.length ? +((confirmed + conflict) / results.length).toFixed(4) : 0,
    },
  };
}

module.exports = { reconcile, reconcileAll, STATUS, _internals: { normName, num, normStatus, COMPARATORS, GOOD_ENTITY } };
