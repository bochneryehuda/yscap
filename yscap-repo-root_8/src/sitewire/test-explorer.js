'use strict';
/**
 * Sitewire TEST-environment capability explorer — READ-ONLY field discovery.
 *
 * Purpose: the owner wants "every single thing you can do in Sitewire" surfaced as a PILOT
 * feature, but our hard NEVER-GUESS rule means we may only write to a Sitewire field whose
 * EXACT name we have actually seen. This module safely READS the Sitewire *test* system and
 * enumerates every object type + field name it exposes, so new integrations can be built on
 * confirmed names instead of guesses.
 *
 * Safety, by construction:
 *   - GET-ONLY. There is no PATCH/POST/PUT/DELETE code path in this file at all — it cannot write.
 *   - Bound to a SEPARATE credential set (SITEWIRE_TEST_ACCESS_TOKEN/_CLIENT/_UID/_BASE_URL). It
 *     never reads the production Sitewire creds, so it can never touch the live directory/data.
 *   - Refuses to run unless the test creds are set (a pasted-in-chat key is never used — the owner
 *     places the test key in Render env; we read it from there like every other secret).
 *   - Values are REDACTED: the catalog records field NAMES + TYPES only (plus distinct values for a
 *     small allowlist of clearly-non-PII enum fields like status/method/type), never PII or bytes.
 */
const cfg = require('../config');

const TIMEOUT_MS = Math.max(1000, parseInt(process.env.SITEWIRE_TIMEOUT_MS || '25000', 10) || 25000);

function testConfigured() {
  return !!(cfg.sitewireTestAccessToken && cfg.sitewireTestClient && cfg.sitewireTestUid);
}
function authHeaders() {
  if (!testConfigured()) {
    throw new Error('SITEWIRE_TEST_ACCESS_TOKEN / SITEWIRE_TEST_CLIENT / SITEWIRE_TEST_UID are not all set — ' +
      'set the TEST key in Render (never pasted in chat) before running the explorer');
  }
  return {
    'access-token': cfg.sitewireTestAccessToken,
    client: cfg.sitewireTestClient,
    uid: cfg.sitewireTestUid,
    Accept: 'application/json',
  };
}
function base() { return cfg.sitewireTestBaseUrl || 'https://app.sitewire.co'; }

// The ONLY network primitive in this module. GET only — method is hardcoded, not a parameter.
async function get(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base()}${path}`, { method: 'GET', headers: authHeaders(), signal: ac.signal });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const e = new Error(`Sitewire TEST GET ${path} -> ${res.status}`);
      e.status = res.status; e.body = data; throw e;
    }
    return data;
  } finally { clearTimeout(timer); }
}

// ---- field catalog collection (values redacted) ----
// Distinct values are collected ONLY for these clearly-non-PII enum-ish leaf names — exactly the
// low-cardinality fields whose exact string values a future WRITE needs (never-guess), and which
// carry no borrower/lender PII.
const ENUM_SAFE = new Set([
  'status', 'state', 'inspection_method', 'development_type', 'construction_type', 'property_type',
  'media_type', 'kind', 'type', 'role', 'quick_notify_status', 'draw_status', 'funding_status',
  'transition', 'action', 'method',
]);
const jsType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Fields we ALREADY integrate (leaf names) — used to mark each discovered field new vs covered.
const INTEGRATED = new Set([
  // property
  'loan_number', 'capital_partner_id', 'address', 'total_units', 'development_type', 'construction_type',
  'borrower_entity_name', 'inspection_method', 'require_sitewire_inspector', 'require_capital_partner_approval',
  'allow_reallocation', 'processing_fee_cents', 'default_draw_coordinator_id', 'draw_checklist_template_id',
  'inactive', 'draw_eligible', 'require_sitewire_inspector',
  // budget / job item
  'name', 'budgeted_cents', 'required_image_count', 'required_video_count', 'mandatory', 'description',
  'draw_eligible', 'funding_ratio', 'funding_threshold_cents', 'id',
  // draw
  'number', 'total_requested_cents', 'total_approved_cents', 'pdf_src', 'draw_events', 'coordinator_id',
  'quick_notify_status_id', 'historical',
  // request
  'requested_cents', 'approved_cents', 'lender_comments', 'job_item', 'inspector_comments', 'inspections',
  // borrower / media
  'contact_email', 'src', 'thumbnail', 'latitude', 'longitude', 'captured_at', 'note',
]);

// Collect the union of keys for a given object TYPE into `catalog[type]`, recursing one level into
// nested objects/arrays under a namespaced type (e.g. "property.budget"). Scalar VALUES are never
// stored, except distinct enum values for ENUM_SAFE leaf names.
function collect(catalog, type, obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return;
  const bucket = catalog[type] || (catalog[type] = {});
  for (const [k, v] of Object.entries(obj)) {
    const t = jsType(v);
    const field = bucket[k] || (bucket[k] = { types: new Set(), integrated: INTEGRATED.has(k), values: null });
    field.types.add(t);
    if (ENUM_SAFE.has(k) && t === 'string' && v.length && v.length <= 40) {
      (field.values || (field.values = new Set())).add(v);
    }
    if (t === 'object') collect(catalog, `${type}.${k}`, v, depth + 1);
    else if (t === 'array' && v.length && v[0] && typeof v[0] === 'object' && !Array.isArray(v[0])) {
      for (const el of v.slice(0, 5)) collect(catalog, `${type}.${k}[]`, el, depth + 1);
    }
  }
}

// Turn the internal collector (Sets) into a plain, serializable catalog.
function finalize(catalog) {
  const out = {};
  for (const [type, fields] of Object.entries(catalog)) {
    out[type] = Object.entries(fields)
      .map(([name, f]) => ({
        name,
        type: [...f.types].sort().join('|'),
        integrated: f.integrated,
        enum_values: f.values ? [...f.values].sort().slice(0, 12) : undefined,
      }))
      .sort((a, b) => (a.integrated === b.integrated ? a.name.localeCompare(b.name) : a.integrated ? 1 : -1));
  }
  return out;
}

/**
 * Explore the Sitewire test environment read-only and return a field catalog.
 * @param {object} opts { sampleProperties?:number, sampleDraws?:number }
 * @returns {Promise<{ok, base_url, lender_id, counts, catalog, new_fields, errors, generated_note }>}
 */
async function explore({ sampleProperties = 5, sampleDraws = 5 } = {}) {
  if (!testConfigured()) {
    return { ok: false, error: 'test_creds_missing',
      message: 'Set SITEWIRE_TEST_ACCESS_TOKEN / _CLIENT / _UID (and _BASE_URL) in Render, then run again.' };
  }
  const catalog = {};
  const errors = [];
  const counts = {};
  const lenderId = cfg.sitewireTestLenderId;
  const safe = async (label, fn) => { try { return await fn(); } catch (e) { errors.push(`${label}: ${e.status || ''} ${e.message}`); return null; } };

  // 1) Lender bundle (users + capital partners live here)
  const lender = await safe('getLender', () => get(`/api/v2/lenders/${lenderId}`));
  if (lender) {
    collect(catalog, 'lender', lender);
    if (Array.isArray(lender.users)) lender.users.slice(0, 8).forEach((u) => collect(catalog, 'lender.users[]', u));
    if (Array.isArray(lender.capital_partners)) lender.capital_partners.slice(0, 8).forEach((c) => collect(catalog, 'lender.capital_partners[]', c));
  }
  // 2) Capital partners + quick-notify statuses (their own endpoints)
  const partners = await safe('listCapitalPartners', () => get('/api/v2/capital_partners'));
  if (Array.isArray(partners)) { counts.capital_partners = partners.length; partners.slice(0, 8).forEach((p) => collect(catalog, 'capital_partner', p)); }
  const qns = await safe('listQuickNotifyStatuses', () => get('/api/v2/quick_notify_statuses'));
  if (Array.isArray(qns)) { counts.quick_notify_statuses = qns.length; qns.slice(0, 20).forEach((q) => collect(catalog, 'quick_notify_status', q)); }

  // 3) Properties → budget → job items
  const props = await safe('listProperties', () => get('/api/v2/properties'));
  const propList = Array.isArray(props) ? props : (props && Array.isArray(props.properties) ? props.properties : []);
  counts.properties = propList.length;
  propList.slice(0, 3).forEach((p) => collect(catalog, 'property_list_item', p));
  for (const stub of propList.slice(0, sampleProperties)) {
    const id = stub && (stub.id || stub.property_id);
    if (!id) continue;
    const prop = await safe(`getProperty(${id})`, () => get(`/api/v2/properties/${id}`));
    if (!prop) continue;
    collect(catalog, 'property', prop);
    const budgetId = prop.budget && (prop.budget.id) ? prop.budget.id : prop.budget_id;
    if (prop.budget && typeof prop.budget === 'object') collect(catalog, 'property.budget', prop.budget);
    if (budgetId) {
      const budget = await safe(`getBudget(${budgetId})`, () => get(`/api/v2/budgets/${budgetId}`));
      if (budget) collect(catalog, 'budget', budget);
    }
  }

  // 4) Draws → requests → inspections → media
  const draws = await safe('listDraws', () => get('/api/v2/draws'));
  const drawList = Array.isArray(draws) ? draws : (draws && Array.isArray(draws.draws) ? draws.draws : []);
  counts.draws = drawList.length;
  drawList.slice(0, 3).forEach((d) => collect(catalog, 'draw_list_item', d));
  for (const stub of drawList.slice(0, sampleDraws)) {
    const id = stub && (stub.id || stub.draw_id);
    if (!id) continue;
    const draw = await safe(`getDraw(${id})`, () => get(`/api/v2/draws/${id}`));
    if (!draw) continue;
    collect(catalog, 'draw', draw);
    // requests hang off a draw in most shapes; sample a couple and fetch their detail
    const reqs = Array.isArray(draw.requests) ? draw.requests : [];
    for (const r of reqs.slice(0, 3)) {
      collect(catalog, 'draw.requests[]', r);
      const rid = r && r.id;
      if (rid) { const detail = await safe(`getRequest(${rid})`, () => get(`/api/v2/requests/${rid}`)); if (detail) collect(catalog, 'request', detail); }
    }
  }

  const finalCatalog = finalize(catalog);
  // New (not-yet-integrated) leaf fields, de-duped by name across all types — the build backlog.
  const seen = new Set(), newFields = [];
  for (const [type, fields] of Object.entries(finalCatalog)) {
    for (const f of fields) {
      if (f.integrated) continue;
      const key = `${type}::${f.name}`;
      if (seen.has(key)) continue; seen.add(key);
      newFields.push({ type, name: f.name, ftype: f.type, enum_values: f.enum_values });
    }
  }
  return {
    ok: errors.length === 0 || Object.keys(finalCatalog).length > 0,
    base_url: base(),
    lender_id: lenderId,
    counts,
    catalog: finalCatalog,
    new_fields: newFields,
    errors,
    generated_note: 'READ-ONLY test-environment discovery. Values redacted; only field names, types, and non-PII enum values are shown.',
  };
}

module.exports = { explore, testConfigured, _internal: { collect, finalize, ENUM_SAFE, INTEGRATED } };
