'use strict';
/**
 * LONG-TERM — LoanNEX's OWN field registry, read from LoanNEX.
 *
 * THE DIFFERENCE FROM LENDER PRICE, AND WHY THIS FILE IS SHORT. Lender Price's
 * field vocabulary had to be decoded by hand from captures, which is why
 * `lenderprice/field-registry.js` is 27KB of hand-recorded mappings that rot the
 * day the vendor renames a token. LoanNEX SHIPS ITS OWN REGISTRY: one GET on
 * `/loans/apps/{userGuid}/settings` returns all 95 fields with their type and,
 * for every dropdown, the exact enum keys the pricing body accepts. So the rule
 * here is *generate, never hand-maintain* — the live answer IS the registry, and
 * this module only caches it and answers questions about it.
 *
 * FAIL CLOSED. `assertOption` throws on a value the live registry does not list.
 * A scenario is never "defaulted" to something plausible: an unknown enum is a
 * caller error, surfaced by name, because a silently substituted enum prices a
 * DIFFERENT loan and returns numbers that look right.
 *
 * THE OFFLINE FALLBACK IS A REAL CAPTURE, NOT A GUESS. `capture/field-registry.json`
 * is the verbatim 95-field answer recorded on 2026-08-30 (portal web.loannex.com),
 * used when the live fetch is unavailable and by every pure test. It is stamped
 * with its provenance so a reader can never mistake it for the live sheet, and
 * `provenance()` reports which of the two answered.
 *
 * PURE apart from the one fetch it is handed. No database, no RTL import.
 */

const CAPTURED = require('./capture/field-registry.json');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** One cache entry per portal — portals are separate LoanNEX tenants. */
const cache = new Map();

function indexFields(fields) {
  const byName = new Map();
  for (const f of fields || []) {
    const name = f && f.uniqueName;
    if (!name) continue;
    byName.set(String(name), {
      uniqueName: String(name),
      displayText: f.displayText || null,
      fieldType: f.fieldType || null,
      flags: f.flags || 'None',
      options: Array.isArray(f.options)
        ? f.options.map((o) => ({ key: String(o.key), value: o.value == null ? null : String(o.value) }))
        : [],
    });
  }
  return byName;
}

/** The captured registry, indexed. Never mutated — callers get their own view. */
function capturedRegistry() {
  return {
    source: 'captured',
    recordedOn: (CAPTURED._captured && CAPTURED._captured.recordedOn) || null,
    fieldCount: (CAPTURED.fields || []).length,
    byName: indexFields(CAPTURED.fields),
  };
}

/**
 * The registry for a portal. `fetchLive` is an async () => settingsResponseData,
 * supplied by the client so this module stays network-free and testable. A live
 * failure falls back to the capture and SAYS SO in `source` — it never throws,
 * because a stale-but-real vocabulary still prices correctly far more often than
 * refusing to price at all, and the provenance rides every answer.
 */
async function registryFor(portal, fetchLive, opts = {}) {
  const key = String(portal || 'default');
  const ttl = Number(opts.ttlMs) > 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.registry;

  let registry = capturedRegistry();
  if (typeof fetchLive === 'function') {
    try {
      const data = await fetchLive();
      const fields = data && Array.isArray(data.fields) ? data.fields : null;
      if (fields && fields.length) {
        registry = { source: 'live', recordedOn: new Date(now).toISOString(), fieldCount: fields.length, byName: indexFields(fields) };
      }
    } catch (_) { /* fall through to the capture, stamped as such */ }
  }
  cache.set(key, { registry, expiresAt: now + ttl });
  return registry;
}

function field(registry, uniqueName) {
  const r = registry && registry.byName ? registry.byName : indexFields(CAPTURED.fields);
  return r.get(String(uniqueName)) || null;
}

/** Every enum key a dropdown accepts, in the vendor's own order. */
function optionKeys(registry, uniqueName) {
  const f = field(registry, uniqueName);
  return f ? f.options.map((o) => o.key) : [];
}

function isOption(registry, uniqueName, key) {
  if (key == null) return false;
  return optionKeys(registry, uniqueName).includes(String(key));
}

/**
 * FAIL CLOSED on an enum the registry does not list. The thrown error names the
 * field, the offending value and what was allowed, so a caller can fix the input
 * rather than guess at it.
 */
function assertOption(registry, uniqueName, key, label) {
  if (isOption(registry, uniqueName, key)) return String(key);
  const allowed = optionKeys(registry, uniqueName);
  const err = new Error(
    `loannex_invalid_${String(label || uniqueName).toLowerCase()}: ${JSON.stringify(key)} is not a ${uniqueName} option` +
    (allowed.length ? ` (allowed: ${allowed.join(', ')})` : ' (registry lists no options for this field)'));
  err.code = 'loannex_invalid_option';
  err.field = String(uniqueName);
  err.value = key;
  err.allowed = allowed;
  throw err;
}

function provenance(registry) {
  return {
    source: (registry && registry.source) || 'captured',
    recordedOn: (registry && registry.recordedOn) || null,
    fieldCount: (registry && registry.fieldCount) || 0,
  };
}

function resetCache() { cache.clear(); }

module.exports = {
  registryFor, capturedRegistry, field, optionKeys, isOption, assertOption, provenance, resetCache,
  DEFAULT_TTL_MS,
  _internals: { indexFields, cache },
};
